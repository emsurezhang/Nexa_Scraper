/**
 * Fetch 命令
 * 执行网页抓取任务
 */

import { Command } from 'commander';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';
import { createLogger } from '../../core/logger.js';
import { pluginRegistry } from '../../core/plugin-registry.js';
import { browserManager, createPage, PageWrapper } from '../../core/capabilities/browser.js';
import { injectStealth } from '../../core/capabilities/stealth.js';
import { loadCookies } from '../../core/capabilities/cookie-manager.js';
import { jobOperations, resultOperations } from '../../core/db.js';
import type { FetchOptions, SingleItem, ListItem, NexaPlugin } from '../../core/plugin-contract.js';
import type { Page } from 'playwright';
import config from '../../core/config.js';

const logger = createLogger({ module: 'cli:fetch' });

export function registerFetchCommand(program: Command): void {
  program
    .command('fetch <url>')
    .description('抓取指定 URL 的内容')
    .option('--debug', '输出调试产物到 debug/ 目录')
    .option('--debug-dir <path>', '自定义调试输出目录')
    .option('--screenshot <mode>', '截图策略：none|viewport|full', config.fetch.defaultScreenshot)
    .option('--output-json <path>', '结果输出到文件')
    .option('--format <mode>', '输出格式：raw|delta|full', config.fetch.defaultFormat)
    .option('--proxy <url>', '代理地址')
    .option('--limit <n>', '列表页最大提取条数', String(config.fetch.defaultLimit))
    .option('--min <n>', '列表页最小提取条数（不足则滚动加载更多）')
    .option('--headless <bool>', '是否无头（默认 true，--debug 时默认 false）')
    .option('--plugin <name>', '强制指定插件')
    .option('--batch <file>', '批量抓取，每行一个 URL')
    .option('--parallel <n>', '批量并发数', '3')
    .option('--output-dir <path>', '批量结果输出目录')
    .option('--retry <n>', '最大重试次数', String(config.queue.retryMax))
    .option('--timeout <ms>', '单次抓取超时', String(config.fetch.defaultTimeout))
    .option('-d, --dry-run', '模拟运行（验证插件匹配，不启动浏览器）')
    .action(async (urlOrBatch: string, options) => {
      // 处理批量模式
      if (options.batch) {
        await handleBatchFetch(options);
        return;
      }

      // 单 URL 模式
      const result = await fetchSingleUrl(urlOrBatch, options);
      
      if (result.success) {
        const output = JSON.stringify(result.data, null, 2);
        
        if (options.outputJson) {
          writeFileSync(options.outputJson, output);
          console.log(`✓ 结果已保存到 ${options.outputJson}`);
        } else {
          console.log(output);
        }
      } else {
        console.error(`✗ 抓取失败: ${result.error}`);
        process.exit(1);
      }
    });
}

// 抓取单个 URL
async function fetchSingleUrl(
  url: string,
  options: Record<string, string | boolean>
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  // --debug 模式下默认关闭 headless，方便观察浏览器行为
  // 用户显式传 --headless true/false 可覆盖
  const isDebug = options.debug as boolean;
  const rawHeadless = options.headless as string | undefined;
  let headless: boolean;
  if (rawHeadless !== undefined) {
    headless = rawHeadless === 'true';
  } else {
    headless = isDebug ? false : true;
  }

  const fetchOptions: FetchOptions = {
    format: options.format as FetchOptions['format'],
    limit: parseInt(options.limit as string),
    minItems: options.min ? parseInt(options.min as string) : undefined,
    debug: isDebug,
    debugDir: options.debugDir as string | undefined,
    screenshot: options.screenshot as FetchOptions['screenshot'],
    proxy: options.proxy as string | undefined,
    headless,
    plugin: options.plugin as string | null | undefined,
    timeout: parseInt(options.timeout as string),
  };

  // 1. 解析插件
  let plugin;
  try {
    plugin = fetchOptions.plugin
      ? pluginRegistry.get(fetchOptions.plugin)
      : pluginRegistry.resolve(url);
    
    if (!plugin) {
      throw new Error(`Plugin not found: ${fetchOptions.plugin}`);
    }
    
    logger.info(`Using plugin: ${plugin.meta.name}`);
  } catch (error) {
    return { success: false, error: `Failed to resolve plugin: ${error}` };
  }

  // 2. 模拟运行模式
  if (options.dryRun) {
    return {
      success: true,
      data: {
        url,
        plugin: plugin.meta.name,
        dryRun: true,
      },
    };
  }

  // 3. 创建调试目录
  let debugDir: string | undefined;
  if (fetchOptions.debug) {
    const dateStr = dayjs().format('YYYY-MM-DD_HH-mm-ss');
    const hash = uuidv4().slice(0, 6);
    debugDir = fetchOptions.debugDir || resolve(
      process.cwd(),
      config.storage.debugDir,
      'fetch',
      `${dateStr}_${hash}`
    );
    mkdirSync(debugDir, { recursive: true });
    logger.debug(`Debug directory: ${debugDir}`);
  }

  const jobId = `job_${uuidv4().slice(0, 12)}`;
  const startTime = Date.now();
  
  // 4. 记录任务
  jobOperations.create({
    id: jobId,
    url,
    plugin: plugin.meta.name,
    status: 'running',
    options: JSON.stringify(fetchOptions),
    result: null,
    error: null,
    retries: 0,
    started_at: startTime,
    completed_at: null,
  });

  try {
    // 5. 启动浏览器
    await browserManager.launch({
      headless: fetchOptions.headless,
      proxy: fetchOptions.proxy,
    });

    // 6. 创建页面
    const pageWrapper = await createPage(browserManager);
    const { page } = pageWrapper;

    // 7. 加载 Cookie
    const cookieDomain = new URL(url).hostname;
    const cookies = loadCookies(cookieDomain);
    if (cookies) {
      await pageWrapper.context.addCookies(cookies);
      logger.info(`Loaded ${cookies.length} cookies for ${cookieDomain}`);
    } else {
      logger.info(`No cookies found for ${cookieDomain}`);
    }

    // 8. 注入 Stealth 脚本
    await injectStealth(page);

    // 9. 导航到页面
    await pageWrapper.goto(url, fetchOptions.timeout);

    // 10. 截图（初始状态）
    if (debugDir && fetchOptions.screenshot !== 'none') {
      await pageWrapper.screenshot(join(debugDir, '01-initial.png'), false);
    }

    // 11. 等待内容加载
    await plugin.waitForContent(page);

    // 12. 截图（等待后）
    if (debugDir && fetchOptions.screenshot !== 'none') {
      await pageWrapper.screenshot(
        join(debugDir, '02-post-wait.png'),
        fetchOptions.screenshot === 'full'
      );
    }

    // 13. 获取 HTML
    const html = await pageWrapper.getHtml();

    // 14. 保存 DOM
    if (debugDir) {
      writeFileSync(join(debugDir, 'dom.html'), html);
    }

    // 15. 判断页面类型并提取数据
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
          extractedData.length,
          fetchOptions.minItems,
          logger,
        );
      }

      // 应用 limit
      if (Array.isArray(extractedData) && fetchOptions.limit) {
        extractedData = extractedData.slice(0, fetchOptions.limit);
      }
    } else {
      extractedData = await plugin.extractSingle(html, url);
    }

    // 16. 媒体处理（单视频页：yt-dlp 下载音频 + Whisper 字幕）
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

    // 17. 保存提取结果
    if (debugDir) {
      writeFileSync(
        join(debugDir, 'extract-raw.json'),
        JSON.stringify(extractedData, null, 2)
      );
    }

    // 18. 保存到数据库（用于 delta 对比）
    if (!Array.isArray(extractedData)) {
      resultOperations.save({
        url,
        domain: new URL(url).hostname,
        content_id: extractedData.id,
        data: JSON.stringify(extractedData),
        fetched_at: Date.now(),
      });
    }

    // 19. 保存 Cookie 快照
    if (debugDir) {
      const finalCookies = await pageWrapper.context.cookies();
      const { maskCookies } = await import('../../core/capabilities/cookie-manager.js');
      writeFileSync(
        join(debugDir, 'cookies-snapshot.json'),
        JSON.stringify(maskCookies(finalCookies), null, 2)
      );
    }

    // 20. 关闭页面
    await pageWrapper.close();

    const duration = Date.now() - startTime;

    // 21. 更新任务状态
    jobOperations.updateStatus(jobId, 'completed', {
      result: JSON.stringify(extractedData),
      completed_at: Date.now(),
    });

    // 22. 保存调试元数据
    if (debugDir) {
      writeFileSync(
        join(debugDir, 'meta.json'),
        JSON.stringify({
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

    logger.info(`Fetch completed in ${duration}ms`);

    return {
      success: true,
      data: {
        url,
        fetchedAt: new Date().toISOString(),
        durationMs: duration,
        plugin: plugin.meta.name,
        pageType,
        result: extractedData,
      },
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    jobOperations.updateStatus(jobId, 'failed', {
      error: errorMsg,
      completed_at: Date.now(),
    });

    return { success: false, error: errorMsg };
  } finally {
    // 关闭浏览器
    await browserManager.close();
  }
}

// 批量抓取
async function handleBatchFetch(options: Record<string, string | boolean>): Promise<void> {
  const batchFile = options.batch as string;
  
  if (!existsSync(batchFile)) {
    console.error(`✗ 文件不存在: ${batchFile}`);
    process.exit(1);
  }

  const content = readFileSync(batchFile, 'utf-8');
  const urls = content.split('\n').filter(url => url.trim());
  
  console.log(`批量抓取 ${urls.length} 个 URL...`);

  const outputDir = (options.outputDir as string) || './batch-results';
  mkdirSync(outputDir, { recursive: true });

  const parallel = parseInt(options.parallel as string) || 3;
  const results: Array<{ url: string; success: boolean; error?: string }> = [];

  // 简单的并行控制
  for (let i = 0; i < urls.length; i += parallel) {
    const batch = urls.slice(i, i + parallel);
    
    const batchPromises = batch.map(async (url, idx) => {
      console.log(`[${i + idx + 1}/${urls.length}] 抓取: ${url}`);
      
      const result = await fetchSingleUrl(url, options);
      
      if (result.success) {
        const filename = `result_${i + idx}_${Date.now()}.json`;
        writeFileSync(
          join(outputDir, filename),
          JSON.stringify(result.data, null, 2)
        );
      }
      
      results.push({
        url,
        success: result.success,
        error: result.error,
      });
    });

    await Promise.all(batchPromises);
  }

  // 保存摘要
  const summary = {
    total: urls.length,
    success: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  };

  writeFileSync(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\n批量抓取完成:`);
  console.log(`  成功: ${summary.success}`);
  console.log(`  失败: ${summary.failed}`);
  console.log(`  结果保存在: ${outputDir}`);
}

export default registerFetchCommand;

/**
 * 滚动页面加载更多列表内容，直到达到 minItems 或无更多内容
 */
async function scrollForMore(
  page: Page,
  pageWrapper: PageWrapper,
  plugin: NexaPlugin,
  url: string,
  currentCount: number,
  minItems: number,
  log: ReturnType<typeof createLogger>,
): Promise<ListItem[]> {
  const maxScrolls = 500;
  const stableChecks = 5;
  const hasPluginItemCount = typeof plugin.getListItemCount === 'function';

  let stableCount = 0;
  let lastHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  let lastItemCount = hasPluginItemCount
    ? await plugin.getListItemCount!(page)
    : currentCount;

  for (let i = 0; i < maxScrolls; i++) {
    // 已达到目标数量
    if (hasPluginItemCount) {
      const count = await plugin.getListItemCount!(page);
      if (count >= minItems) {
        log.info(`Reached ${count} items (target: ${minItems}), stopping scroll`);
        break;
      }
    }

    // 渐进式滚动：先滚一屏，再到底部
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(1500);
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );

    // 轮询等待新内容
    const gotNew = await waitForNewContent(page, plugin, lastItemCount, lastHeight);

    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const currentItems = hasPluginItemCount
      ? await plugin.getListItemCount!(page)
      : 0;

    if (!gotNew && currentHeight === lastHeight && currentItems === lastItemCount) {
      stableCount++;
      // 额外等待让渲染完成后再判断
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
        log.info(
          `No more content after ${stableCount} checks (items=${currentItems}, height=${currentHeight})`,
        );
        break;
      }
    } else {
      stableCount = 0;
    }

    lastHeight = currentHeight;
    lastItemCount = currentItems;

    if ((i + 1) % 10 === 0) {
      log.info(`Scrolled ${i + 1} times, items=${currentItems}, height=${currentHeight}`);
    }
  }

  // 从活跃 DOM 提取（优先）或重新获取 HTML 提取
  if (typeof plugin.extractListFromPage === 'function') {
    return plugin.extractListFromPage(page, url);
  }
  const latestHtml = await pageWrapper.getHtml();
  return plugin.extractList(latestHtml, url);
}

/**
 * 轮询等待新内容加载（不使用 waitForLoadState 避免 SPA 路由重置）
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

  // 先等一会让请求发出
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
