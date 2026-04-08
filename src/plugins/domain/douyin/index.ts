/**
 * 抖音插件
 * 功能：
 *   1. 抓取用户主页的视频列表
 *   2. 抓取单个视频页的详情
 *   3. 通过 Playwright 网络拦截下载音频 + whisper 生成字幕
 */

import type { Page } from 'playwright';
import type {
  NexaPlugin,
  PluginMeta,
  ListItem,
  SingleItem,
  LoginState,
} from '../../../core/plugin-contract.js';
import { matchUrl, pageType } from './url-matcher.js';
import { waitForContent } from './waiting-strategy.js';
import { checkLoginState } from './login-state.js';
import { extractList, extractSingle } from './extractor.js';
import { downloadMedia } from './media.js';
import type { MediaDownloadResult } from './media.js';

export type { MediaDownloadResult };

export default class DouyinPlugin implements NexaPlugin {
  meta: PluginMeta = {
    name: 'douyin',
    version: '1.0.0',
    domains: ['douyin.com', 'www.douyin.com', 'm.douyin.com'],
    priority: 3,
    author: 'Nexa Team',
    requiresLogin: false,
  };

  matchUrl(url: string): number | null {
    return matchUrl(url);
  }

  pageType(url: string, _html: string): 'list' | 'single' | 'unknown' {
    return pageType(url);
  }

  async waitForContent(page: Page): Promise<void> {
    return waitForContent(page);
  }

  async extractList(html: string, url: string): Promise<ListItem[]> {
    return extractList(html, url);
  }

  async extractSingle(html: string, url: string): Promise<SingleItem> {
    return extractSingle(html, url);
  }

  async checkLoginState(page: Page): Promise<LoginState> {
    return checkLoginState(page);
  }

  async getListItemCount(page: Page): Promise<number> {
    return page.evaluate(() => {
      for (const sel of ['[data-e2e="user-post-list"] li', '.ECMy_UnSmQ-', '[class*="VideoList"] li']) {
        const n = document.querySelectorAll(sel).length;
        if (n > 0) return n;
      }
      return 0;
    });
  }

  async extractListFromPage(page: Page, _url: string): Promise<ListItem[]> {
    return page.evaluate(() => {
      const items: { id: string; url: string; title?: string }[] = [];
      const seen = new Set<string>();
      document.querySelectorAll('[data-e2e="user-post-list"] li, [class*="VideoList"] li').forEach((el) => {
        const link = el.querySelector('a[href*="/video/"]') as HTMLAnchorElement | null;
        if (!link) return;
        const href = link.getAttribute('href') ?? '';
        const m = /\/video\/(\d+)/.exec(href);
        if (!m) return;
        const videoId = m[1];
        if (seen.has(videoId)) return;
        seen.add(videoId);
        const title = (el.querySelector('.title, [class*="title"], [class*="desc"]') as HTMLElement)?.textContent?.trim() || '';
        if (!title) return;
        const fullUrl = href.startsWith('http') ? href : `https://www.douyin.com${href}`;
        items.push({ id: videoId, url: fullUrl, title });
      });
      return items;
    });
  }

  /**
   * 下载视频音频并生成字幕。
   * 使用 Playwright 网络拦截捕获 douyinvod 音频 URL + whisper 转录。
   * fetch.ts 通过 `typeof plugin.downloadMedia === 'function'` 检测此方法。
   */
  async downloadMedia(url: string, outputDir: string): Promise<MediaDownloadResult> {
    return downloadMedia(url, outputDir);
  }
}
