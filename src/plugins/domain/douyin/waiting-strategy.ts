/**
 * 抖音页面等待策略
 *
 * 抖音是一个重 JS SPA，内容通过客户端渲染。
 * 视频页需要等待播放器和描述区加载；
 * 用户主页需要等待视频列表网格渲染 + 滚动触发懒加载。
 */

import type { Page } from 'playwright';
import { createLogger } from '../../../core/logger.js';
import { pageType } from './url-matcher.js';

const logger = createLogger({ module: 'plugin:douyin:wait' });

/** 视频条目选择器 */
const VIDEO_ITEM_SELECTOR = [
  '[data-e2e="user-post-list"] li',    // 用户主页视频列表
  '.ECMy_UnSmQ-',                       // 视频卡片容器 class
  '[class*="VideoList"] li',            // 视频列表项
].join(', ');

/** 视频详情页选择器 */
const VIDEO_DETAIL_SELECTOR = [
  '[data-e2e="video-desc"]',            // 视频描述
  '.video-info-detail',                 // 视频详情
  'xg-video-container',                 // 播放器容器
  '[class*="videoPlayer"]',             // 播放器
].join(', ');

/** 根据页面类型决定等待策略 */
export async function waitForContent(page: Page): Promise<void> {
  const type = pageType(page.url());

  if (type === 'list') {
    await waitForList(page);
  } else {
    await waitForSingle(page);
  }
}

/** 等待用户主页视频列表渲染 */
async function waitForList(page: Page): Promise<void> {
  try {
    await page.waitForSelector(VIDEO_ITEM_SELECTOR, { timeout: 30_000 });
  } catch {
    logger.warn('Video list items did not appear within timeout');
  }
  // 滚动以触发更多视频懒加载
  await autoScroll(page, 3);
}

/** 等待视频详情页渲染 */
async function waitForSingle(page: Page): Promise<void> {
  try {
    await page.waitForSelector(VIDEO_DETAIL_SELECTOR, { timeout: 30_000 });
  } catch {
    logger.warn('Video detail did not appear within timeout');
  }
  // 等待播放器和互动数据加载
  await page.waitForTimeout(2000);
}

/** 向下滚动以触发懒加载 */
async function autoScroll(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.evaluate('window.scrollBy(0, window.innerHeight)');
    await page.waitForTimeout(1500);
  }
}
