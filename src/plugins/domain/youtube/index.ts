/**
 * YouTube 插件
 * 功能：
 *   1. 抓取频道 Videos Tab 的视频列表
 *   2. 抓取单个视频页的详情
 *   3. 通过 yt-dlp 下载音频 + whisper 生成字幕
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

export default class YouTubePlugin implements NexaPlugin {
  meta: PluginMeta = {
    name: 'youtube',
    version: '1.0.0',
    domains: ['youtube.com', 'www.youtube.com', 'm.youtube.com'],
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
    return page.evaluate(() =>
      document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer').length,
    );
  }

  async extractListFromPage(page: Page, _url: string): Promise<ListItem[]> {
    return page.evaluate(() => {
      const items: { id: string; url: string; title: string; meta: Record<string, string | undefined> }[] = [];
      const seen = new Set<string>();
      document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer').forEach((el) => {
        const titleLink = el.querySelector('a#video-title-link, a#video-title') as HTMLAnchorElement | null;
        const anyLink = el.querySelector('a[href*="watch?v="]') as HTMLAnchorElement | null;
        const link = titleLink || anyLink;
        if (!link) return;
        const href = link.getAttribute('href') ?? '';
        const m = /[?&]v=([a-zA-Z0-9_-]{11})/.exec(href);
        if (!m) return;
        const videoId = m[1];
        if (seen.has(videoId)) return;
        seen.add(videoId);
        const title = titleLink?.getAttribute('title')
          || el.querySelector('yt-formatted-string#video-title')?.textContent?.trim()
          || '';
        const metaEl = el.querySelector('#metadata-line');
        const spans = metaEl ? metaEl.querySelectorAll('span') : [];
        const viewCount = spans[0]?.textContent?.trim();
        const publishedTime = spans[1]?.textContent?.trim();
        const durationEl = el.querySelector(
          'badge-shape .badge-shape-wiz__text, ytd-thumbnail-overlay-time-status-renderer #text, span.ytd-thumbnail-overlay-time-status-renderer',
        );
        const duration = durationEl?.textContent?.trim();
        const thumbEl = el.querySelector('img#img, yt-image img') as HTMLImageElement | null;
        const thumbnail = thumbEl?.src || undefined;
        items.push({ id: videoId, url: `https://www.youtube.com/watch?v=${videoId}`, title, meta: { viewCount, publishedTime, duration, thumbnail } });
      });
      return items;
    });
  }

  /**
   * 下载视频音频并生成字幕。
   * 使用 yt-dlp 下载最佳音频 + whisper 转录。
   * fetch.ts 通过 `typeof plugin.downloadMedia === 'function'` 检测此方法。
   */
  async downloadMedia(url: string, outputDir: string): Promise<MediaDownloadResult> {
    return downloadMedia(url, outputDir);
  }
}
