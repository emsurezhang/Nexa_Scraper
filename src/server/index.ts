/**
 * HTTP API Server
 * 使用 Fastify 框架提供 RESTful API
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { createLogger } from '../core/logger.js';
import { browserPool } from '../core/capabilities/browser-pool.js';
import { taskQueue } from '../core/queue.js';
import { pluginRegistry } from '../core/plugin-registry.js';
import { executeFetchTask } from '../core/task-executor.js';
import config from '../core/config.js';

import { registerFetchRoutes } from './routes/fetch.js';
import { registerCookiesRoutes } from './routes/cookies.js';
import { registerPluginsRoutes } from './routes/plugins.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthMiddleware } from './middleware/auth.js';

const logger = createLogger({ module: 'server' });

export interface ServerOptions {
  port?: number;
  host?: string;
}

// 创建并启动服务器
export async function startServer(options: ServerOptions = {}): Promise<void> {
  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;

  // 创建 Fastify 实例
  const app = Fastify({
    logger: false, // 使用我们自己的 logger
  });

  // 注册 CORS
  await app.register(cors, {
    origin: true,
  });

  // 注册速率限制
  await app.register(rateLimit, {
    max: config.server.rateLimit.max,
    timeWindow: config.server.rateLimit.windowMs,
  });

  // 注册认证中间件
  await registerAuthMiddleware(app);

  // 注册路由
  await registerFetchRoutes(app);
  await registerCookiesRoutes(app);
  await registerPluginsRoutes(app);
  await registerHealthRoutes(app);

  // 加载插件
  await pluginRegistry.load();

  // 初始化浏览器资源池
  await browserPool.init();

  // 设置任务队列处理器
  taskQueue.setHandler(async (task) => {
    logger.info(`Processing task: ${task.id}`);
    
    // 执行真实的抓取任务
    return await executeFetchTask(task, {
      debug: task.options.debug,
    });
  });

  // 优雅关闭处理
  const gracefulShutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    
    await app.close();
    await browserPool.drain();
    
    logger.info('Server shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // 启动服务器
  try {
    await app.listen({ port, host });
    logger.info(`Server listening on http://${host}:${port}`);
    
    console.log(`✓ Server started on http://${host}:${port}`);
    console.log(`  Health check: http://${host}:${port}/health`);
    console.log(`  API docs: http://${host}:${port}/docs`);
  } catch (err) {
    logger.error(`Failed to start server: ${err}`);
    process.exit(1);
  }
}

export default startServer;
