/**
 * X.com 页面等待策略
 *
 * X 是一个 React SPA，内容通过 XHR 按需加载。
 * 需要等待推文 DOM 渲染完成后再提取。
 */

import type { Page } from 'playwright';
import { createLogger } from '../../../core/logger.js';

const logger = createLogger({ module: 'plugin:x-com:wait' });

/** 推文行的 DOM 选择器 */
const TWEET_SELECTOR = 'article[data-testid="tweet"]';

/** 等待列表页（用户 timeline）推文渲染 */
export async function waitForList(page: Page): Promise<void> {
  try {
    await page.waitForSelector(TWEET_SELECTOR, { timeout: 60_000 });
  } catch {
    logger.warn('Tweets did not appear within timeout');
  }

  // 滚动以触发更多推文懒加载
  await autoScroll(page, 3);
}

/** 等待单条推文详情页渲染 */
export async function waitForSingle(page: Page): Promise<void> {
  try {
    await page.waitForSelector(TWEET_SELECTOR, { timeout: 60_000 });
  } catch {
    logger.warn('Tweet detail did not appear within timeout');
  }
  // 给回复列表一点时间渲染
  await page.waitForTimeout(1500);
}

/** 向下滚动以触发懒加载 */
async function autoScroll(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.evaluate('window.scrollBy(0, window.innerHeight)');
    await page.waitForTimeout(1200);
  }
}
