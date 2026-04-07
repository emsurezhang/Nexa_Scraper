/**
 * 健康检查路由
 * GET /health
 * GET /metrics
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../../core/logger.js';
import { browserPool } from '../../core/capabilities/browser-pool.js';
import { taskQueue } from '../../core/queue.js';
import { getDatabase } from '../../core/db.js';
import config from '../../core/config.js';

const logger = createLogger({ module: 'server:health' });

// 服务器启动时间
const startTime = Date.now();

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  // 健康检查
  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // 检查数据库连接
      const db = getDatabase();
      db.prepare('SELECT 1').get();

      const poolStats = browserPool.stats();
      const queueStats = taskQueue.getStats();

      reply.send({
        status: 'ok',
        version: config.app.version,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        browserPool: {
          active: poolStats.active,
          idle: poolStats.idle,
          max: poolStats.maxSize,
        },
        queue: {
          pending: queueStats.pending,
          running: queueStats.running,
        },
        db: 'ok',
      });
    } catch (error) {
      logger.error(`Health check failed: ${error}`);
      reply.status(503).send({
        status: 'degraded',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Prometheus 格式指标
  app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    const poolStats = browserPool.stats();
    const queueStats = taskQueue.getStats();
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    const metrics = [
      '# HELP nexa_uptime_seconds Server uptime in seconds',
      '# TYPE nexa_uptime_seconds gauge',
      `nexa_uptime_seconds ${uptime}`,
      '',
      '# HELP nexa_browser_pool_active Number of active browsers',
      '# TYPE nexa_browser_pool_active gauge',
      `nexa_browser_pool_active ${poolStats.active}`,
      '',
      '# HELP nexa_browser_pool_idle Number of idle browsers',
      '# TYPE nexa_browser_pool_idle gauge',
      `nexa_browser_pool_idle ${poolStats.idle}`,
      '',
      '# HELP nexa_queue_pending Number of pending tasks',
      '# TYPE nexa_queue_pending gauge',
      `nexa_queue_pending ${queueStats.pending}`,
      '',
      '# HELP nexa_queue_running Number of running tasks',
      '# TYPE nexa_queue_running gauge',
      `nexa_queue_running ${queueStats.running}`,
      '',
      '# HELP nexa_queue_completed_total Total number of completed tasks',
      '# TYPE nexa_queue_completed_total counter',
      `nexa_queue_completed_total ${queueStats.completed}`,
      '',
      '# HELP nexa_queue_failed_total Total number of failed tasks',
      '# TYPE nexa_queue_failed_total counter',
      `nexa_queue_failed_total ${queueStats.failed}`,
    ].join('\n');

    reply.type('text/plain').send(metrics);
  });
}

export default registerHealthRoutes;
