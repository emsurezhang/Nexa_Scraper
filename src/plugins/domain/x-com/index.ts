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

  async getListItemCount(page: Page): Promise<number> {
    return page.evaluate(() =>
      document.querySelectorAll('article[data-testid="tweet"]').length,
    );
  }

  async extractListFromPage(page: Page, _url: string): Promise<ListItem[]> {
    return page.evaluate(() => {
      const items: { id: string; url: string; title?: string }[] = [];
      const seen = new Set<string>();
      document.querySelectorAll('article[data-testid="tweet"]').forEach((el) => {
        const links = el.querySelectorAll('a[href*="/status/"]');
        let tweetUrl = '';
        let postId = '';
        for (const a of links) {
          const href = (a as HTMLAnchorElement).getAttribute('href') ?? '';
          const m = /\/status\/(\d+)/.exec(href);
          if (m) { postId = m[1]; tweetUrl = href.startsWith('http') ? href : `https://x.com${href}`; break; }
        }
        if (!postId || seen.has(postId)) return;
        seen.add(postId);
        const text = (el.querySelector('[data-testid="tweetText"]') as HTMLElement)?.textContent?.trim() || '';
        items.push({ id: postId, url: tweetUrl, title: text.slice(0, 200) || undefined });
      });
      return items;
    });
  }
}
