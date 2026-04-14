/**
 * Fetch 路由
 * POST /fetch - 提交抓取任务
 * GET /fetch/:jobId - 查询任务状态
 * DELETE /fetch/:jobId - 取消任务
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../../core/logger.js';
import { taskQueue } from '../../core/queue.js';
import { jobOperations } from '../../core/db.js';
import type { FetchOptions } from '../../core/plugin-contract.js';

const logger = createLogger({ module: 'server:fetch' });

// 请求类型定义
interface FetchRequest {
  url: string;
  options?: FetchOptions;
}

interface FetchParams {
  jobId: string;
}

export async function registerFetchRoutes(app: FastifyInstance): Promise<void> {
  // 提交抓取任务
  app.post('/fetch', async (
    request: FastifyRequest<{ Body: FetchRequest }>,
    reply: FastifyReply
  ) => {
    try {
      const { url, options = {} } = request.body;

      if (!url) {
        reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing required field: url',
        });
        return;
      }

      // 验证 URL
      try {
        new URL(url);
      } catch {
        reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid URL',
        });
        return;
      }

      logger.info(`Fetch request received: ${url}`);

      // 添加到队列
      const { taskId, promise } = await taskQueue.enqueue(url, options, 5);

      // 任务立即开始执行（队列空闲时）
      // 或者返回排队信息
      const stats = taskQueue.getStats();
      
      reply.status(202).send({
        jobId: taskId,
        status: 'queued',
        position: stats.pending,
        estimatedWaitSec: stats.pending * 5, // 粗略估计
      });

      // 异步处理任务
      promise
        .then((result) => {
          jobOperations.updateStatus(taskId, 'completed', {
            result: JSON.stringify(result),
            completed_at: Date.now(),
          });
          logger.info(`Job ${taskId} completed`);
        })
        .catch((error) => {
          jobOperations.updateStatus(taskId, 'failed', {
            error: error instanceof Error ? error.message : String(error),
            completed_at: Date.now(),
          });
          logger.error(`Job ${taskId} failed: ${error}`);
        });

    } catch (error) {
      logger.error(`Fetch request failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 查询任务状态
  app.get('/fetch/:jobId', async (
    request: FastifyRequest<{ Params: FetchParams }>,
    reply: FastifyReply
  ) => {
    try {
      const { jobId } = request.params;
      logger.debug(`Get job status request received: jobId=${jobId}, ip=${request.ip}`);

      // 先检查队列中的任务
      const task = taskQueue.getTask(jobId);
      const result = taskQueue.getResult(jobId);
      const error = taskQueue.getError(jobId);

      logger.debug(
        `Queue lookup for jobId=${jobId}: task=${Boolean(task)}, result=${Boolean(result)}, error=${Boolean(error)}`
      );

      if (task) {
        // 任务仍在队列或处理中
        const queueStatus = result ? 'completed' : error ? 'failed' : 'running';
        logger.debug(`Job ${jobId} found in queue with status=${queueStatus}`);
        reply.send({
          jobId,
          status: queueStatus,
          url: task.url,
          result: result || null,
          error: error ? error.message : null,
        });
        return;
      }

      // 检查数据库中的历史任务
      logger.debug(`Job ${jobId} not in queue, checking database`);
      const job = jobOperations.get(jobId);

      if (!job) {
        logger.debug(`Job ${jobId} not found in database`);
        reply.status(404).send({
          error: 'Not Found',
          message: 'Job not found',
        });
        return;
      }

      logger.debug(`Job ${jobId} found in database with status=${job.status}`);

      reply.send({
        jobId,
        status: job.status,
        url: job.url,
        startedAt: job.started_at ? new Date(job.started_at).toISOString() : null,
        completedAt: job.completed_at ? new Date(job.completed_at).toISOString() : null,
        plugin: job.plugin,
        result: job.result ? JSON.parse(job.result) : null,
        error: job.error,
      });

    } catch (error) {
      logger.error(`Get job status failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 取消任务
  app.delete('/fetch/:jobId', async (
    request: FastifyRequest<{ Params: FetchParams }>,
    reply: FastifyReply
  ) => {
    try {
      const { jobId } = request.params;

      // 检查任务是否存在
      const job = jobOperations.get(jobId);
      
      if (!job) {
        reply.status(404).send({
          error: 'Not Found',
          message: 'Job not found',
        });
        return;
      }

      // 只能取消排队中的任务
      if (job.status !== 'queued' && job.status !== 'running') {
        reply.status(400).send({
          error: 'Bad Request',
          message: `Cannot cancel job with status: ${job.status}`,
        });
        return;
      }

      // 更新状态为取消
      jobOperations.updateStatus(jobId, 'cancelled', {
        completed_at: Date.now(),
      });

      logger.info(`Job ${jobId} cancelled`);

      reply.send({
        jobId,
        status: 'cancelled',
      });

    } catch (error) {
      logger.error(`Cancel job failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 列出任务（可选）
  app.get('/fetch', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { status, limit = '10' } = request.query as { status?: string; limit?: string };
      
      const jobs = jobOperations.list({
        status: status as any,
        limit: parseInt(limit),
      });

      reply.send({
        jobs: jobs.map(job => ({
          id: job.id,
          url: job.url,
          status: job.status,
          plugin: job.plugin,
          createdAt: new Date(job.created_at).toISOString(),
        })),
      });

    } catch (error) {
      logger.error(`List jobs failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export default registerFetchRoutes;
