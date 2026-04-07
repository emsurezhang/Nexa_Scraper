/**
 * Cookies 路由
 * GET /cookies - 列出所有 Cookie
 * POST /cookies/:domain - 触发交互式登录
 * DELETE /cookies/:domain - 删除 Cookie
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../../core/logger.js';
import { listCookies, getCookieMeta, deleteCookies } from '../../core/capabilities/cookie-manager.js';

const logger = createLogger({ module: 'server:cookies' });

// 请求参数类型
interface CookieParams {
  domain: string;
}

// 交互式登录请求体
interface LoginRequest {
  headless?: boolean;
}

export async function registerCookiesRoutes(app: FastifyInstance): Promise<void> {
  // 列出所有 Cookie
  app.get('/cookies', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const cookies = listCookies();
      
      reply.send({
        cookies: cookies.map(cookie => ({
          domain: cookie.domain,
          status: cookie.status,
          itemCount: cookie.itemCount,
          expiresAt: cookie.expiresAt ? new Date(cookie.expiresAt).toISOString() : null,
          updatedAt: new Date(cookie.updatedAt).toISOString(),
        })),
      });

    } catch (error) {
      logger.error(`List cookies failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 获取单个域名的 Cookie
  app.get('/cookies/:domain', async (
    request: FastifyRequest<{ Params: CookieParams }>,
    reply: FastifyReply
  ) => {
    try {
      const { domain } = request.params;
      const meta = getCookieMeta(domain);

      if (!meta) {
        reply.status(404).send({
          error: 'Not Found',
          message: `No cookies found for domain: ${domain}`,
        });
        return;
      }

      reply.send({
        domain: meta.domain,
        status: meta.status,
        itemCount: meta.itemCount,
        expiresAt: meta.expiresAt ? new Date(meta.expiresAt).toISOString() : null,
        updatedAt: new Date(meta.updatedAt).toISOString(),
      });

    } catch (error) {
      logger.error(`Get cookie failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 触发交互式登录
  app.post('/cookies/:domain', async (
    request: FastifyRequest<{ Params: CookieParams; Body: LoginRequest }>,
    reply: FastifyReply
  ) => {
    try {
      const { domain } = request.params;
      const { headless = false } = request.body || {};

      logger.info(`Interactive login requested for ${domain}`);

      // 注意：在服务器上运行交互式登录需要显示器或 VNC
      // 这里返回 202 表示异步操作
      reply.status(202).send({
        message: 'Interactive login initiated',
        domain,
        note: 'This requires a display (X11 or VNC) on the server',
        status: 'pending',
      });

      // 实际实现需要在有图形界面的环境中运行
      // 以下是简化示例
      if (!headless) {
        logger.warn('Interactive login requires headful browser on server');
      }

    } catch (error) {
      logger.error(`Interactive login failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 删除 Cookie
  app.delete('/cookies/:domain', async (
    request: FastifyRequest<{ Params: CookieParams }>,
    reply: FastifyReply
  ) => {
    try {
      const { domain } = request.params;
      
      deleteCookies(domain);
      
      logger.info(`Cookies deleted for ${domain}`);
      
      reply.send({
        message: 'Cookies deleted',
        domain,
      });

    } catch (error) {
      logger.error(`Delete cookie failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export default registerCookiesRoutes;
