/**
 * 浏览器资源池模块
 * 仅在 Server 模式启用，管理 Browser 和 BrowserContext 的复用
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import config from '../config.js';
import { createLogger } from '../logger.js';

const logger = createLogger({ module: 'browser-pool' });

export interface PoolConfig {
  minSize: number;
  maxSize: number;
  idleTimeoutMs: number;
  healthCheckIntervalMs: number;
  maxContextLifetimeMs: number;
}

export interface PooledBrowser {
  id: string;
  browser: Browser;
  activeContexts: number;
  createdAt: Date;
  lastUsedAt: Date;
  isHealthy: boolean;
}

export interface PoolStats {
  total: number;
  active: number;
  idle: number;
  maxSize: number;
  contextsInUse: number;
}

export interface PoolContext {
  id: string;
  browserId: string;
  context: BrowserContext;
  createdAt: Date;
}

// 浏览器资源池
export class BrowserPool {
  private browsers = new Map<string, PooledBrowser>();
  private contexts = new Map<string, PoolContext>();
  private config: PoolConfig;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(poolConfig?: Partial<PoolConfig>) {
    this.config = {
      minSize: poolConfig?.minSize ?? config.pool.minSize,
      maxSize: poolConfig?.maxSize ?? config.pool.maxSize,
      idleTimeoutMs: poolConfig?.idleTimeoutMs ?? config.pool.idleTimeoutMs,
      healthCheckIntervalMs: poolConfig?.healthCheckIntervalMs ?? config.pool.healthCheckIntervalMs,
      maxContextLifetimeMs: poolConfig?.maxContextLifetimeMs ?? config.pool.maxContextLifetimeMs,
    };
  }

  // 初始化资源池
  async init(): Promise<void> {
    logger.info(`Initializing browser pool (minSize: ${this.config.minSize}, maxSize: ${this.config.maxSize})`);
    
    // 创建最小数量的浏览器实例
    for (let i = 0; i < this.config.minSize; i++) {
      await this.createBrowser();
    }

    // 启动健康检查
    this.startHealthCheck();
    
    // 启动清理定时器
    this.startCleanupTimer();

    logger.info('Browser pool initialized');
  }

  // 创建新的浏览器实例
  private async createBrowser(): Promise<PooledBrowser> {
    const id = `browser_${uuidv4().slice(0, 8)}`;
    
    logger.debug(`Creating browser instance: ${id}`);
    
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const pooledBrowser: PooledBrowser = {
      id,
      browser,
      activeContexts: 0,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      isHealthy: true,
    };

    this.browsers.set(id, pooledBrowser);
    
    logger.debug(`Browser instance created: ${id}, version: ${browser.version()}`);
    
    return pooledBrowser;
  }

  // 获取一个 BrowserContext
  async acquire(): Promise<BrowserContext> {
    // 找一个有空闲容量的浏览器
    let pooledBrowser = this.findAvailableBrowser();

    // 如果没有可用浏览器且未达到最大数量，创建新的
    if (!pooledBrowser && this.browsers.size < this.config.maxSize) {
      pooledBrowser = await this.createBrowser();
    }

    // 还是没有可用浏览器，等待
    if (!pooledBrowser) {
      throw new Error('Browser pool exhausted. All browsers are at maximum capacity.');
    }

    // 创建新的 Context
    const context = await pooledBrowser.browser.newContext({
      locale: config.browser.locale,
      timezoneId: config.browser.timezone,
      viewport: {
        width: config.browser.viewportWidth,
        height: config.browser.viewportHeight,
      },
    });

    const contextId = `ctx_${uuidv4().slice(0, 8)}`;
    const poolContext: PoolContext = {
      id: contextId,
      browserId: pooledBrowser.id,
      context,
      createdAt: new Date(),
    };

    this.contexts.set(contextId, poolContext);
    pooledBrowser.activeContexts++;
    pooledBrowser.lastUsedAt = new Date();

    logger.debug(`Context acquired: ${contextId} from browser ${pooledBrowser.id}`);

    return context;
  }

  // 释放 BrowserContext
  async release(context: BrowserContext): Promise<void> {
    // 找到对应的 pool context
    const entry = Array.from(this.contexts.entries()).find(
      ([, ctx]) => ctx.context === context
    );

    if (!entry) {
      logger.warn('Trying to release unknown context');
      return;
    }

    const [contextId, poolContext] = entry;
    const browser = this.browsers.get(poolContext.browserId);

    if (browser) {
      browser.activeContexts = Math.max(0, browser.activeContexts - 1);
    }

    // 关闭 context
    try {
      await context.close();
    } catch (error) {
      logger.warn(`Error closing context: ${error}`);
    }

    this.contexts.delete(contextId);
    logger.debug(`Context released: ${contextId}`);
  }

  // 查找可用的浏览器
  private findAvailableBrowser(): PooledBrowser | undefined {
    for (const browser of this.browsers.values()) {
      if (browser.isHealthy && browser.activeContexts < 10) { // 每个浏览器最多 10 个 context
        return browser;
      }
    }
    return undefined;
  }

  // 启动健康检查
  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      for (const [id, browser] of this.browsers.entries()) {
        try {
          // 简单的健康检查：尝试获取版本
          const version = await browser.browser.version();
          browser.isHealthy = true;
          logger.trace(`Health check passed for browser ${id}: ${version}`);
        } catch (error) {
          browser.isHealthy = false;
          logger.error(`Health check failed for browser ${id}: ${error}`);
          
          // 关闭不健康的浏览器
          try {
            await browser.browser.close();
          } catch {}
          
          this.browsers.delete(id);
          
          // 如果低于最小数量，创建新的
          if (this.browsers.size < this.config.minSize) {
            await this.createBrowser();
          }
        }
      }
    }, this.config.healthCheckIntervalMs);
  }

  // 启动清理定时器
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      
      // 检查超时的 context
      for (const [id, context] of this.contexts.entries()) {
        const age = now - context.createdAt.getTime();
        
        if (age > this.config.maxContextLifetimeMs) {
          logger.warn(`Context ${id} exceeded max lifetime, forcing release`);
          this.release(context.context).catch(err => {
            logger.error(`Error releasing expired context: ${err}`);
          });
        }
      }

      // 检查空闲超时的浏览器
      for (const [id, browser] of this.browsers.entries()) {
        if (browser.activeContexts === 0) {
          const idleTime = now - browser.lastUsedAt.getTime();
          
          // 超过空闲时间且超过最小数量，关闭浏览器
          if (idleTime > this.config.idleTimeoutMs && this.browsers.size > this.config.minSize) {
            logger.info(`Closing idle browser: ${id}`);
            browser.browser.close().catch(() => {});
            this.browsers.delete(id);
          }
        }
      }
    }, 60000); // 每分钟检查一次
  }

  // 获取统计信息
  stats(): PoolStats {
    const total = this.browsers.size;
    const active = Array.from(this.browsers.values()).filter(b => b.activeContexts > 0).length;
    const contextsInUse = Array.from(this.contexts.values()).length;

    return {
      total,
      active,
      idle: total - active,
      maxSize: this.config.maxSize,
      contextsInUse,
    };
  }

  // 优雅关闭
  async drain(): Promise<void> {
    logger.info('Draining browser pool...');

    // 停止定时器
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // 关闭所有 context
    for (const context of this.contexts.values()) {
      try {
        await context.context.close();
      } catch {}
    }
    this.contexts.clear();

    // 关闭所有浏览器
    for (const browser of this.browsers.values()) {
      try {
        await browser.browser.close();
      } catch {}
    }
    this.browsers.clear();

    logger.info('Browser pool drained');
  }
}

// 导出单例
export const browserPool = new BrowserPool();

export default browserPool;
