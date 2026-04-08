/**
 * X.com (Twitter) 插件
 * 功能：
 *   1. 抓取指定用户的 Posts Tab 推文列表
 *   2. 抓取单条推文详情页
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
import { waitForList, waitForSingle } from './waiting-strategy.js';
import { checkLoginState } from './login-state.js';
import { extractList, extractSingle } from './extractor.js';

export default class XComPlugin implements NexaPlugin {
  meta: PluginMeta = {
    name: 'x-com',
    version: '1.0.0',
    domains: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
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
    const type = pageType(page.url());
    if (type === 'list') {
      await waitForList(page);
    } else {
      await waitForSingle(page);
    }
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
}
