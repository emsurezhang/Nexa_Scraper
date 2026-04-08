/**
 * YouTube 页面等待策略
 *
 * YouTube 是一个重 JS SPA，内容通过客户端渲染。
 * 列表页需要等待视频网格 + 滚动触发懒加载；
 * 视频页等待播放器和描述区渲染，但不等 networkidle（广告/推荐持续加载）。
 */

import type { Page } from 'playwright';
import { pageType } from './url-matcher.js';

/** 根据页面类型决定等待策略 */
export async function waitForContent(page: Page): Promise<void> {
  const type = pageType(page.url());

  if (type === 'list') {
    await waitForList(page);
  } else {
    await waitForSingle(page);
  }
}

/** 等待列表页（频道 Videos Tab）视频网格渲染 */
async function waitForList(page: Page): Promise<void> {
  try {
    await page.waitForSelector(
      'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer',
      { timeout: 15_000 },
    );
  } catch {
    // 可能页面结构变了，继续
  }
  // 让懒加载多渲染一些
  await autoScroll(page, 3);
}

/** 等待视频详情页播放器 + 描述区渲染 */
async function waitForSingle(page: Page): Promise<void> {
  try {
    await page.waitForSelector('#above-the-fold, #info-contents, ytd-watch-metadata', {
      timeout: 15_000,
    });
  } catch {
    // 继续
  }
  // YouTube watch 页持续加载广告/推荐，不等 networkidle
  await page.waitForTimeout(2000);
}

/** 自动向下滚动，让 YouTube 懒加载更多视频 */
async function autoScroll(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.evaluate('window.scrollBy(0, window.innerHeight)');
    await page.waitForTimeout(1200);
  }
}
