/**
 * 任务执行器
 * 封装真实的网页抓取逻辑，供 Server 模式和 CLI 模式共用
 */

import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import type { BrowserContext, Page } from 'playwright';
import { pluginRegistry } from './plugin-registry.js';
import { browserPool } from './capabilities/browser-pool.js';
import { injectStealth } from './capabilities/stealth.js';
import { loadCookies } from './capabilities/cookie-manager.js';
import { jobOperations, resultOperations } from './db.js';
import { createLogger } from './logger.js';
import config from './config.js';
import type { FetchTask } from './queue.js';
import type {
  FetchResult,
  NexaPlugin,
  SingleItem,
  ListItem,
} from './plugin-contract.js';

const logger = createLogger({ module: 'task-executor' });

export interface TaskExecutorOptions {
  debug?: boolean;
  debugDir?: string;
}

// 有效的页面类型
type ValidPageType = 'list' | 'single';

// 页面包装器（复用 browser.ts 中的逻辑，适配 BrowserContext）
interface PageWrapper {
  page: Page;
  context: BrowserContext;
  goto: (url: string, timeout?: number) => Promise<void>;
  getHtml: () => Promise<string>;
  screenshot: (path: string, fullPage?: boolean) => Promise<void>;
  close: () => Promise<void>;
}

async function createPageWrapper(context: BrowserContext): Promise<PageWrapper> {
  const page = await context.newPage();

  return {
    page,
    context,
    goto: async (url: string, timeout = config.fetch.defaultTimeout) => {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      // 等待额外时间让动态内容加载
      await page.waitForTimeout(2000);
    },
    getHtml: async () => {
      return page.content();
    },
    screenshot: async (path: string, fullPage = false) => {
      await page.screenshot({
        path,
        fullPage,
      });
    },
    close: async () => {
      await page.close();
    },
  };
}

/**
 * 执行抓取任务
 */
export async function executeFetchTask(
  task: FetchTask,
  options: TaskExecutorOptions = {}
): Promise<FetchResult> {
  const { url, options: fetchOptions } = task;
  const isDebug = options.debug ?? fetchOptions.debug ?? false;
  const jobId = task.id;
  const startTime = Date.now();

  logger.info(`Starting fetch task: ${jobId} for ${url}`);

  // 1. 解析插件
  let plugin: NexaPlugin;
  try {
    plugin = fetchOptions.plugin
      ? pluginRegistry.get(fetchOptions.plugin)!
      : pluginRegistry.resolve(url);
    logger.info(`Using plugin: ${plugin.meta.name}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve plugin: ${msg}`);
  }

  // 2. 创建调试目录
  let debugDir: string | undefined;
  if (isDebug) {
    const dateStr = dayjs().format('YYYY-MM-DD_HH-mm-ss');
    const hash = uuidv4().slice(0, 6);
    debugDir = options.debugDir || resolve(
      process.cwd(),
      config.storage.debugDir,
      'server',
      `${dateStr}_${hash}`
    );
    mkdirSync(debugDir, { recursive: true });
    logger.debug(`Debug directory: ${debugDir}`);
  }

  // 3. 更新任务状态为运行中
  jobOperations.updateStatus(jobId, 'running', {
    started_at: startTime,
  });

  let context: BrowserContext | undefined;
  let pageWrapper: PageWrapper | undefined;

  try {
    // 4. 从浏览器池获取 Context
    context = await browserPool.acquire();
    
    // 5. 创建页面
    pageWrapper = await createPageWrapper(context);
    const { page } = pageWrapper;

    // 6. 加载 Cookie
    const cookieDomain = new URL(url).hostname;
    const cookies = loadCookies(cookieDomain);
    if (cookies) {
      await context.addCookies(cookies);
      logger.info(`Loaded ${cookies.length} cookies for ${cookieDomain}`);
    }

    // 7. 注入 Stealth 脚本
    await injectStealth(page);

    // 8. 导航到页面
    await pageWrapper.goto(url, fetchOptions.timeout);

    // 9. 截图（初始状态）
    if (debugDir && fetchOptions.screenshot !== 'none') {
      await pageWrapper.screenshot(join(debugDir, '01-initial.png'), false);
    }

    // 10. 等待内容加载
    await plugin.waitForContent(page);

    // 11. 截图（等待后）
    if (debugDir && fetchOptions.screenshot !== 'none') {
      await pageWrapper.screenshot(
        join(debugDir, '02-post-wait.png'),
        fetchOptions.screenshot === 'full'
      );
    }

    // 12. 获取 HTML
    const html = await pageWrapper.getHtml();

    // 13. 保存 DOM
    if (debugDir) {
      writeFileSync(join(debugDir, 'dom.html'), html);
    }

    // 14. 判断页面类型并提取数据
    const pageType = plugin.pageType(url, html);
    logger.debug(`Page type: ${pageType}`);

    let extractedData: SingleItem | ListItem[];

    if (pageType === 'list') {
      extractedData = await plugin.extractList(html, url);

      // --min: 如果提取数量不足，滚动加载更多内容
      if (
        fetchOptions.minItems &&
        Array.isArray(extractedData) &&
        extractedData.length < fetchOptions.minItems
      ) {
        logger.info(
          `Got ${extractedData.length} items, need at least ${fetchOptions.minItems}, scrolling for more...`,
        );
        extractedData = await scrollForMore(
          page,
          pageWrapper,
          plugin,
          url,
          extractedData as ListItem[],
          fetchOptions.minItems,
        );
      }

      // 应用 limit
      if (Array.isArray(extractedData) && fetchOptions.limit) {
        extractedData = extractedData.slice(0, fetchOptions.limit);
      }
    } else {
      extractedData = await plugin.extractSingle(html, url);
    }

    // 15. 媒体处理（单视频页：yt-dlp 下载音频 + Whisper 字幕）
    if (pageType !== 'list' && typeof (plugin as any).downloadMedia === 'function') {
      try {
        const mediaDir = debugDir
          ? join(debugDir, 'media')
          : resolve(config.storage.tmpDir, `media_${jobId}`);

        logger.info('Downloading media via plugin...');
        const mediaResult = await (plugin as any).downloadMedia(url, mediaDir);

        (extractedData as SingleItem).raw = {
          ...(extractedData as SingleItem).raw,
          media: {
            audioPath: mediaResult.audioPath,
            subtitlePath: mediaResult.subtitlePath,
            transcriptPath: mediaResult.transcriptPath,
            durationSec: mediaResult.durationSec,
          },
        };

        // 将字幕文本写入 transcript 字段
        if (mediaResult.transcriptPath && existsSync(mediaResult.transcriptPath)) {
          (extractedData as SingleItem).transcript = readFileSync(
            mediaResult.transcriptPath,
            'utf-8',
          );
        }

        logger.info(
          `Media done: audio=${mediaResult.audioPath}, srt=${mediaResult.subtitlePath ?? 'none'}, txt=${mediaResult.transcriptPath ?? 'none'}`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Media download skipped: ${msg}`);
      }
    }

    // 16. 保存提取结果
    if (debugDir) {
      writeFileSync(
        join(debugDir, 'extract-raw.json'),
        JSON.stringify(extractedData, null, 2)
      );
    }

    // 17. 保存到数据库（用于 delta 对比）
    if (!Array.isArray(extractedData)) {
      resultOperations.save({
        url,
        domain: new URL(url).hostname,
        content_id: extractedData.id,
        data: JSON.stringify(extractedData),
        fetched_at: Date.now(),
      });
    }

    // 18. 保存 Cookie 快照
    if (debugDir) {
      const finalCookies = await context.cookies();
      const { maskCookies } = await import('./capabilities/cookie-manager.js');
      writeFileSync(
        join(debugDir, 'cookies-snapshot.json'),
        JSON.stringify(maskCookies(finalCookies), null, 2)
      );
    }

    // 19. 关闭页面
    await pageWrapper.close();

    // 20. 释放 Context
    await browserPool.release(context);

    const duration = Date.now() - startTime;

    // 21. 保存调试元数据
    if (debugDir) {
      writeFileSync(
        join(debugDir, 'meta.json'),
        JSON.stringify({
          jobId,
          url,
          plugin: plugin.meta.name,
          options: fetchOptions,
          timestamps: {
            started: startTime,
            completed: Date.now(),
          },
          duration,
          pageType,
          version: config.app.version,
        }, null, 2)
      );
    }

    logger.info(`Fetch task completed: ${jobId} in ${duration}ms`);

    // 返回标准格式的结果（pageType 不能是 'unknown'）
    return {
      id: jobId,
      url,
      data: extractedData,
      fetchedAt: new Date().toISOString(),
      plugin: plugin.meta.name,
      pageType: (pageType === 'unknown' ? 'single' : pageType) as ValidPageType,
    };

  } catch (error) {
    // 清理资源
    if (pageWrapper) {
      await pageWrapper.close().catch(() => {});
    }
    if (context) {
      await browserPool.release(context).catch(() => {});
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Fetch task failed: ${jobId} - ${errorMsg}`);
    
    throw error;
  }
}

/**
 * 滚动页面加载更多列表内容
 */
async function scrollForMore(
  page: Page,
  pageWrapper: PageWrapper,
  plugin: NexaPlugin,
  url: string,
  initialItems: ListItem[],
  minItems: number,
): Promise<ListItem[]> {
  const maxScrolls = 500;
  const stableChecks = 5;
  const collectInterval = 5;
  const hasPluginItemCount = typeof plugin.getListItemCount === 'function';
  const hasExtractFromPage = typeof plugin.extractListFromPage === 'function';

  const accumulated = new Map<string, ListItem>();

  for (const item of initialItems) {
    if (item.id) {
      accumulated.set(item.id, item);
    }
  }

  const collectItems = async () => {
    let items: ListItem[];
    if (hasExtractFromPage) {
      items = await plugin.extractListFromPage!(page, url);
    } else {
      const html = await pageWrapper.getHtml();
      items = await plugin.extractList(html, url);
    }
    for (const item of items) {
      if (item.id && !accumulated.has(item.id)) {
        accumulated.set(item.id, item);
      }
    }
  };

  let stableCount = 0;
  let lastHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  let lastItemCount = hasPluginItemCount
    ? await plugin.getListItemCount!(page)
    : initialItems.length;

  for (let i = 0; i < maxScrolls; i++) {
    if (accumulated.size >= minItems) {
      logger.info(`Reached ${accumulated.size} accumulated items (target: ${minItems}), stopping scroll`);
      break;
    }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(1500);
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );

    const gotNew = await waitForNewContent(page, plugin, lastItemCount, lastHeight);

    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const currentItems = hasPluginItemCount
      ? await plugin.getListItemCount!(page)
      : 0;

    if ((i + 1) % collectInterval === 0 || gotNew) {
      await collectItems();
    }

    if (!gotNew && currentHeight === lastHeight && currentItems === lastItemCount) {
      stableCount++;
      await page.waitForTimeout(3000);
      const recheckHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const recheckItems = hasPluginItemCount
        ? await plugin.getListItemCount!(page)
        : 0;
      if (recheckHeight !== currentHeight || recheckItems !== currentItems) {
        stableCount = 0;
        lastHeight = recheckHeight;
        lastItemCount = recheckItems;
        continue;
      }
      if (stableCount >= stableChecks) {
        await collectItems();
        logger.info(
          `No more content after ${stableCount} checks (accumulated=${accumulated.size}, dom=${currentItems}, height=${currentHeight})`,
        );
        break;
      }
    } else {
      stableCount = 0;
    }

    lastHeight = currentHeight;
    lastItemCount = currentItems;

    if ((i + 1) % 10 === 0) {
      logger.info(`Scrolled ${i + 1} times, accumulated=${accumulated.size}, dom=${currentItems}, height=${currentHeight}`);
    }
  }

  await collectItems();

  return Array.from(accumulated.values());
}

/**
 * 轮询等待新内容加载
 */
async function waitForNewContent(
  page: Page,
  plugin: NexaPlugin,
  prevItemCount: number,
  prevHeight: number,
): Promise<boolean> {
  const hasPluginItemCount = typeof plugin.getListItemCount === 'function';
  const pollInterval = 500;
  const maxWait = 8000;
  let elapsed = 0;

  await page.waitForTimeout(800);
  elapsed += 800;

  while (elapsed < maxWait) {
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    if (h !== prevHeight) return true;

    if (hasPluginItemCount) {
      const c = await plugin.getListItemCount!(page);
      if (c !== prevItemCount) return true;
    }

    await page.waitForTimeout(pollInterval);
    elapsed += pollInterval;
  }

  return false;
}

export default executeFetchTask;
