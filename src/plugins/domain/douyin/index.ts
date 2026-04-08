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

  /**
   * 下载视频音频并生成字幕。
   * 使用 Playwright 网络拦截捕获 douyinvod 音频 URL + whisper 转录。
   * fetch.ts 通过 `typeof plugin.downloadMedia === 'function'` 检测此方法。
   */
  async downloadMedia(url: string, outputDir: string): Promise<MediaDownloadResult> {
    return downloadMedia(url, outputDir);
  }
}
