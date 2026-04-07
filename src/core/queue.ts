/**
 * 任务队列模块
 * 使用 p-queue 实现带优先级和并发控制的任务队列
 */

import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import config from './config.js';
import { createLogger } from './logger.js';
import type { FetchOptions, FetchResult } from './plugin-contract.js';

const logger = createLogger({ module: 'queue' });

export interface FetchTask {
  id: string;
  url: string;
  options: FetchOptions;
  retries: number;
  maxRetries: number;
  priority: number;
}

export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  isPaused: boolean;
}

export type TaskHandler = (task: FetchTask) => Promise<FetchResult>;

// 任务队列类
export class TaskQueue {
  private queue: PQueue;
  private tasks = new Map<string, FetchTask>();
  private results = new Map<string, FetchResult>();
  private errors = new Map<string, Error>();
  private handler: TaskHandler | null = null;
  private stats = {
    completed: 0,
    failed: 0,
  };

  constructor() {
    this.queue = new PQueue({
      concurrency: config.queue.concurrency,
    });
    
    logger.info(`Task queue initialized with concurrency: ${config.queue.concurrency}`);
  }

  // 设置任务处理器
  setHandler(handler: TaskHandler): void {
    this.handler = handler;
  }

  // 添加任务到队列
  async enqueue(
    url: string,
    options: FetchOptions = {},
    priority = 5
  ): Promise<{ taskId: string; promise: Promise<FetchResult> }> {
    const taskId = `job_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    
    const task: FetchTask = {
      id: taskId,
      url,
      options,
      retries: 0,
      maxRetries: config.queue.retryMax,
      priority,
    };

    this.tasks.set(taskId, task);
    
    logger.debug(`Task ${taskId} enqueued: ${url}`);

    const promise = this.executeTask(task);
    
    return { taskId, promise };
  }

  // 执行任务
  private async executeTask(task: FetchTask): Promise<FetchResult> {
    if (!this.handler) {
      throw new Error('No task handler set');
    }

    return this.queue.add(
      async () => {
        logger.info(`Executing task ${task.id}: ${task.url}`);
        
        try {
          const result = await this.runWithRetry(task);
          this.results.set(task.id, result);
          this.stats.completed++;
          return result;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.errors.set(task.id, err);
          this.stats.failed++;
          throw err;
        }
      },
      { priority: task.priority }
    ) as Promise<FetchResult>;
  }

  // 带重试的执行
  private async runWithRetry(task: FetchTask): Promise<FetchResult> {
    while (true) {
      try {
        return await this.handler!(task);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        
        // 判断是否应该重试
        if (!this.shouldRetry(err, task)) {
          throw err;
        }

        task.retries++;
        const delay = this.calculateBackoff(task.retries);
        
        logger.warn(
          `Task ${task.id} failed (attempt ${task.retries}/${task.maxRetries}): ${err.message}. Retrying in ${delay}ms...`
        );
        
        await sleep(delay);
      }
    }
  }

  // 判断是否可重试
  private shouldRetry(error: Error, task: FetchTask): boolean {
    // 超过最大重试次数
    if (task.retries >= task.maxRetries) {
      return false;
    }

    // 可重试的错误类型
    const retryableErrors = [
      'timeout',
      'net::',
      'page crashed',
      'Navigation failed',
      '5', // 5xx 错误
    ];

    const errorMessage = error.message.toLowerCase();
    return retryableErrors.some(pattern => errorMessage.includes(pattern.toLowerCase()));
  }

  // 计算退避时间（指数退避 + Jitter）
  private calculateBackoff(retryCount: number): number {
    const base = config.queue.retryBaseDelayMs;
    const max = config.queue.retryMaxDelayMs;
    
    // 指数退避
    const exponential = base * Math.pow(2, retryCount - 1);
    
    // 添加 Jitter（±20%）
    const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
    
    return Math.min(Math.floor(exponential + jitter), max);
  }

  // 获取任务状态
  getTask(taskId: string): FetchTask | undefined {
    return this.tasks.get(taskId);
  }

  // 获取任务结果
  getResult(taskId: string): FetchResult | undefined {
    return this.results.get(taskId);
  }

  // 获取任务错误
  getError(taskId: string): Error | undefined {
    return this.errors.get(taskId);
  }

  // 获取队列统计
  getStats(): QueueStats {
    return {
      pending: this.queue.size,
      running: this.queue.pending,
      completed: this.stats.completed,
      failed: this.stats.failed,
      isPaused: this.queue.isPaused,
    };
  }

  // 暂停队列
  pause(): void {
    this.queue.pause();
    logger.info('Task queue paused');
  }

  // 恢复队列
  resume(): void {
    this.queue.start();
    logger.info('Task queue resumed');
  }

  // 清空队列
  clear(): void {
    this.queue.clear();
    logger.info('Task queue cleared');
  }

  // 等待所有任务完成
  async onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  // 获取队列中的任务数量
  get size(): number {
    return this.queue.size;
  }

  // 获取正在运行的任务数量
  get pending(): number {
    return this.queue.pending;
  }
}

// 辅助函数
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 导出单例
export const taskQueue = new TaskQueue();

export default taskQueue;
