/**
 * 通用 HTML 解析插件
 * 作为兜底插件，用于处理未匹配的 URL
 */

import * as cheerio from 'cheerio';
import type { Page } from 'playwright';
import type {
  NexaPlugin,
  PluginMeta,
  ListItem,
  SingleItem,
} from '../../core/plugin-contract.js';
import { parseWithReadability, looksLikeListUrl, extractMetadata } from './extractor.js';

export class GeneralHtmlPlugin implements NexaPlugin {
  meta: PluginMeta = {
    name: 'general',
    version: '1.0.0',
    domains: ['*'],
    priority: 999, // 最低优先级
  };

  matchUrl(_url: string): number | null {
    // 通用插件匹配所有 URL，但优先级最低
    return 999;
  }

  pageType(_url: string, html: string): 'list' | 'single' | 'unknown' {
    // URL 模式分析：聚合路径 / 分页 / 首页 → 列表页
    if (looksLikeListUrl(_url)) {
      return 'list';
    }

    // Readability 能提取出有效文章 → single
    const article = parseWithReadability(html, _url);
    if (article && article.length > 200) {
      return 'single';
    }

    // Readability 无法提取有效内容，通过结构化线索判断是否为列表
    const $ = cheerio.load(html);
    const repeatingSelectors = [
      'ul > li > a',
      'ol > li > a',
      '.list-item',
      '[class*="item"]',
    ];
    for (const sel of repeatingSelectors) {
      if ($(sel).length > 5) return 'list';
    }

    return article ? 'single' : 'unknown';
  }

  async waitForContent(page: Page): Promise<void> {
    // 通用插件等待页面基本加载完成
    await page.waitForLoadState('networkidle');
  }

  async extractList(html: string, url: string): Promise<ListItem[]> {
    const $ = cheerio.load(html);
    const items: ListItem[] = [];
    
    // 尝试找到列表容器
    // 常见的列表选择器
    const listSelectors = [
      'article',
      '.post',
      '.item',
      '.list-item',
      '[class*="list"] > div',
      '[class*="item"]',
      'main a[href]',
    ];
    
    for (const selector of listSelectors) {
      const elements = $(selector);
      
      if (elements.length > 1) {
        elements.each((index, el) => {
          const $el = $(el);
          const link = $el.find('a').first();
          const href = link.attr('href') || $el.attr('href');
          const title = $el.find('h1, h2, h3, h4, .title').first().text().trim() ||
                       link.text().trim() ||
                       $el.text().trim().slice(0, 100);
          
          if (href && title) {
            const resolvedUrl = this.resolveUrl(href, url);
            items.push({
              id: `item_${index}_${Date.now()}`,
              url: resolvedUrl,
              title: title.slice(0, 200),
              meta: {
                selector,
                textLength: $el.text().length,
              },
            });
          }
        });
        
        if (items.length > 0) break;
      }
    }
    
    // 如果没找到任何内容，提取所有链接作为兜底
    if (items.length === 0) {
      $('a[href]').each((index, el) => {
        const $el = $(el);
        const href = $el.attr('href');
        const title = $el.text().trim();
        
        if (href && title && title.length > 5) {
          const resolvedUrl = this.resolveUrl(href, url);
          
          // 去重
          if (!items.some(item => item.url === resolvedUrl)) {
            items.push({
              id: `link_${index}_${Date.now()}`,
              url: resolvedUrl,
              title: title.slice(0, 200),
            });
          }
        }
      });
    }
    
    return items.slice(0, 100); // 限制最大数量
  }

  async extractSingle(html: string, url: string): Promise<SingleItem> {
    const meta = extractMetadata(html);
    const article = parseWithReadability(html, url);

    // 标题：Readability > meta > fallback
    const title = article?.title || meta.title || 'Untitled';

    // 内容：优先使用 Readability 纯文本
    let content = article?.textContent ?? '';
    if (content.length < 200) {
      // Readability 提取不到时回退到 cheerio
      const $ = cheerio.load(html);
      const body = $('body').clone();
      body.find('script, style, nav, header, footer, aside').remove();
      content = body.text().trim();
    }
    content = this.cleanContent(content);

    return {
      id: `single_${Date.now()}`,
      url,
      title: title.slice(0, 200),
      content: content.slice(0, 50000),
      publishedAt: meta.publishedAt,
      author: (article?.byline || meta.author)?.slice(0, 100),
      tags: meta.keywords?.slice(0, 20) ?? [],
      raw: {
        contentLength: content.length,
        readability: !!article,
      },
    };
  }

  // 解析相对 URL
  private resolveUrl(href: string, baseUrl: string): string {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  }

  // 清理内容
  private cleanContent(content: string): string {
    return content
      .replace(/\s+/g, ' ')  // 合并空白
      .replace(/\n\s*\n/g, '\n')  // 合并空行
      .trim();
  }
}

export default GeneralHtmlPlugin;
