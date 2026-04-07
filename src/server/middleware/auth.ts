/**
 * 认证中间件
 * 验证 API Token
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import config from '../../core/config.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger({ module: 'server:auth' });

// 公开路由（不需要认证）
const PUBLIC_ROUTES = ['/health', '/metrics', '/docs'];

export async function registerAuthMiddleware(app: FastifyInstance): Promise<void> {
  // 如果认证未启用，跳过
  if (!config.server.auth.enabled) {
    logger.warn('API authentication is disabled');
    return;
  }

  // 从环境变量获取 token
  const validToken = process.env.NEXA_TOKEN || config.server.auth.token;
  
  if (!validToken) {
    logger.warn('NEXA_TOKEN not set, API authentication may not work properly');
  }

  // 添加认证钩子
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // 检查是否是公开路由
    const path = request.url.split('?')[0];
    if (PUBLIC_ROUTES.some(route => path.startsWith(route))) {
      return;
    }

    // 获取 token
    const authHeader = request.headers['x-nexa-token'];
    const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    // 验证 token
    if (!token) {
      logger.warn(`Unauthorized request from ${request.ip}: missing token`);
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing X-Nexa-Token header',
      });
      return;
    }

    if (token !== validToken) {
      logger.warn(`Unauthorized request from ${request.ip}: invalid token`);
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid token',
      });
      return;
    }

    // 认证通过
    logger.debug(`Authenticated request from ${request.ip}`);
  });
}

export default registerAuthMiddleware;
