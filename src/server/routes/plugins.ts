/**
 * Plugins 路由
 * GET /plugins - 列出已安装插件
 * GET /plugins/:name - 插件详情
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../../core/logger.js';
import { pluginRegistry } from '../../core/plugin-registry.js';
import { pluginOperations } from '../../core/db.js';

const logger = createLogger({ module: 'server:plugins' });

// 请求参数类型
interface PluginParams {
  name: string;
}

export async function registerPluginsRoutes(app: FastifyInstance): Promise<void> {
  // 列出所有插件
  app.get('/plugins', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const plugins = pluginRegistry.list();
      const dbRecords = pluginOperations.list();

      reply.send({
        plugins: plugins.map(meta => {
          const record = dbRecords.find(r => r.name === meta.name);
          
          return {
            name: meta.name,
            version: meta.version,
            domains: meta.domains,
            priority: meta.priority,
            author: meta.author,
            requiresLogin: meta.requiresLogin,
            enabled: record ? record.enabled === 1 : true,
          };
        }),
      });

    } catch (error) {
      logger.error(`List plugins failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 获取插件详情
  app.get('/plugins/:name', async (
    request: FastifyRequest<{ Params: PluginParams }>,
    reply: FastifyReply
  ) => {
    try {
      const { name } = request.params;
      
      const plugin = pluginRegistry.get(name);
      const record = pluginOperations.get(name);

      if (!plugin && !record) {
        reply.status(404).send({
          error: 'Not Found',
          message: `Plugin not found: ${name}`,
        });
        return;
      }

      reply.send({
        name: plugin?.meta.name || record?.name,
        version: plugin?.meta.version || record?.version,
        domains: plugin?.meta.domains || [],
        priority: plugin?.meta.priority,
        author: plugin?.meta.author,
        requiresLogin: plugin?.meta.requiresLogin,
        enabled: record ? record.enabled === 1 : true,
        source: record?.source || 'built-in',
        installedAt: record?.installed_at ? new Date(record.installed_at).toISOString() : null,
      });

    } catch (error) {
      logger.error(`Get plugin failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 测试插件 URL 匹配
  app.post('/plugins/:name/test', async (
    request: FastifyRequest<{ 
      Params: PluginParams;
      Body: { url: string }
    }>,
    reply: FastifyReply
  ) => {
    try {
      const { name } = request.params;
      const { url } = request.body;

      if (!url) {
        reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing required field: url',
        });
        return;
      }

      const plugin = pluginRegistry.get(name);

      if (!plugin) {
        reply.status(404).send({
          error: 'Not Found',
          message: `Plugin not found: ${name}`,
        });
        return;
      }

      const priority = plugin.matchUrl(url);

      reply.send({
        name,
        url,
        matched: priority !== null,
        priority,
      });

    } catch (error) {
      logger.error(`Test plugin failed: ${error}`);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export default registerPluginsRoutes;
