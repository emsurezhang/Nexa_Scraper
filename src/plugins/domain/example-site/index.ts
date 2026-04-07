/**
 * Example Site 插件
 * 这是一个示例插件，展示如何实现 NexaPlugin 接口
 */

import * as cheerio from 'cheerio';
import type { Page } from 'playwright';
import type {
  NexaPlugin,
  PluginMeta,
  ListItem,
  SingleItem,
  LoginState,
} from '../../../core/plugin-contract.js';
import { parseWithReadability, looksLikeListUrl, extractMetadata } from '../../general/extractor.js';

export class ExampleSitePlugin implements NexaPlugin {
  meta: PluginMeta = {
    name: 'example-site',
    version: '1.0.0',
    domains: ['example.com', 'www.example.com'],
    priority: 5,
    author: 'Nexa Team',
    requiresLogin: false,
  };

  /**
   * URL 匹配
   * 返回优先级（0-9，数字越小优先级越高），不匹配返回 null
   */
  matchUrl(url: string): number | null {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;

      if (hostname === 'example.com' || hostname === 'www.example.com') {
        return 5;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * 判断页面类型
   * 优先使用 Readability 检测是否为文章页，避免侧边栏/底部链接干扰
   */
  pageType(url: string, html: string): 'list' | 'single' | 'unknown' {
    // 1. URL 模式分析：聚合路径 / 分页 / 首页 → 列表页
    if (looksLikeListUrl(url)) {
      return 'list';
    }

    // 2. Readability 能提取出实质性文章内容 -> single
    const article = parseWithReadability(html, url);
    if (article && article.length > 200) {
      return 'single';
    }

    // 2. 从 URL 路径判断
    if (url.includes('/list') || url.includes('/category') || url.includes('/tag/')) {
      return 'list';
    }
    if (url.match(/\/(post|article|page)\//)) {
      return 'single';
    }

    // 3. 结构化列表特征（只在 Readability 无法提取时才考虑）
    const $ = cheerio.load(html);
    const articleCards = $('.article-card, .post-item, .list-item');
    if (articleCards.length > 3) {
      return 'list';
    }

    return article ? 'single' : 'unknown';
  }

  /**
   * 等待页面内容加载
   */
  async waitForContent(page: Page): Promise<void> {
    // 等待网络空闲
    await page.waitForLoadState('networkidle');

    // 等待主要内容加载
    try {
      // 尝试等待列表或文章内容的任意一个
      await Promise.race([
        page.waitForSelector('.article-list, .post-list', { timeout: 5000 }),
        page.waitForSelector('.article-body, .post-content', { timeout: 5000 }),
      ]);
    } catch {
      // 超时继续，页面可能已经加载完成
    }
  }

  /**
   * 提取列表页数据
   */
  async extractList(html: string, url: string): Promise<ListItem[]> {
    const $ = cheerio.load(html);
    const items: ListItem[] = [];

    // 尝试多种可能的选择器
    const selectors = [
      '.article-card',
      '.post-item',
      '.list-item',
      'article',
      '.article',
      '.post',
    ];

    for (const selector of selectors) {
      $(selector).each((index, element) => {
        const $el = $(element);

        // 提取标题
        const title =
          $el.find('h1, h2, h3, .title, .post-title').first().text().trim() ||
          $el.find('a').first().text().trim();

        // 提取链接
        const href = $el.find('a').first().attr('href');

        if (title && href) {
          const itemUrl = this.resolveUrl(href, url);
          const id = this.extractId(itemUrl) || `item_${index}`;

          items.push({
            id,
            url: itemUrl,
            title: title.slice(0, 200),
            meta: {
              summary: $el.find('.summary, .excerpt, .description').first().text().trim().slice(0, 500),
              publishedAt: $el.find('time').attr('datetime'),
              author: $el.find('.author').text().trim(),
            },
          });
        }
      });

      // 如果找到了内容，就不再尝试其他选择器
      if (items.length > 0) break;
    }

    return items;
  }

  /**
   * 提取单页数据
   * 优先使用 Readability 提取主体内容，回退到 cheerio
   */
  async extractSingle(html: string, url: string): Promise<SingleItem> {
    const $ = cheerio.load(html);
    const meta = extractMetadata(html);
    const article = parseWithReadability(html, url);

    // 标题
    const title =
      article?.title ||
      $('h1').first().text().trim() ||
      meta.title ||
      'Untitled';

    // 内容：优先 Readability
    let content = article?.textContent ?? '';
    if (content.length < 100) {
      const body = $('body').clone();
      body.find('script, style, nav, header, footer, aside').remove();
      content = body.text().trim();
    }

    // 提取作者
    const author =
      article?.byline ||
      $('[rel="author"]').first().text().trim() ||
      $('.author').first().text().trim() ||
      meta.author;

    // 提取发布时间
    const publishedAt =
      meta.publishedAt ||
      $('time[datetime]').first().attr('datetime') ||
      $('.publish-date, .date').first().attr('datetime');

    // 提取标签
    const tags: string[] = meta.keywords?.slice(0, 20) ?? [];
    if (tags.length === 0) {
      $('.tag, [rel="tag"]').each((_, el) => {
        const tag = $(el).text().trim();
        if (tag) tags.push(tag);
      });
    }

    // 提取统计数据
    const stats: Record<string, number> = {};
    const viewsText = $('.views, .view-count').text();
    if (viewsText) {
      const views = parseInt(viewsText.replace(/\D/g, ''), 10);
      if (!isNaN(views)) stats.views = views;
    }

    const likesText = $('.likes, .like-count').text();
    if (likesText) {
      const likes = parseInt(likesText.replace(/\D/g, ''), 10);
      if (!isNaN(likes)) stats.likes = likes;
    }

    return {
      id: this.extractId(url) || `single_${Date.now()}`,
      url,
      title: title.slice(0, 200),
      content: this.cleanContent(content).slice(0, 50000),
      publishedAt,
      author: author?.slice(0, 100),
      tags: tags.slice(0, 20),
      stats,
      raw: {
        htmlLength: html.length,
        contentLength: content.length,
        readability: !!article,
      },
    };
  }

  /**
   * 检查登录状态（可选）
   */
  async checkLoginState(page: Page): Promise<LoginState> {
    // 检查是否存在登录相关的元素
    const loginButton = await page.$('.login-button, .sign-in, [data-action="login"]');
    const userMenu = await page.$('.user-menu, .profile-menu, .account-dropdown');

    if (userMenu) {
      return 'logged-in';
    }

    if (loginButton) {
      return 'logged-out';
    }

    return 'unknown';
  }

  /**
   * 解析相对 URL
   */
  private resolveUrl(href: string, baseUrl: string): string {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  }

  /**
   * 从 URL 提取 ID
   */
  private extractId(url: string): string | null {
    // 尝试匹配常见的 ID 模式
    const patterns = [
      /\/(?:post|article|page)\/(\d+)/,
      /[?&]id=(\d+)/,
      /\/(\d+)\.html?$/,
      /-p-(\d+)(?:\.|$)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return match[1];
      }
    }

    // 使用 URL 路径作为 ID
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname.replace(/\//g, '_').replace(/^_/, '');
      return path || null;
    } catch {
      return null;
    }
  }

  /**
   * 清理内容文本
   */
  private cleanContent(content: string): string {
    return content
      .replace(/\s+/g, ' ') // 合并空白
      .replace(/\n\s*\n/g, '\n') // 合并空行
      .replace(/^\s+|\s+$/g, '') // 去除首尾空白
      .trim();
  }
}

export default ExampleSitePlugin;
