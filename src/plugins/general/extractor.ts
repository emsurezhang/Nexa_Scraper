/**
 * 通用 HTML 提取器
 * 提供常用的 HTML 提取工具函数
 */

import * as cheerio from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ module: 'extractor' });

/** Readability 解析结果 */
export interface ReadabilityResult {
  title: string;
  content: string;       // HTML
  textContent: string;   // 纯文本
  excerpt: string;
  byline: string | null;
  siteName: string | null;
  length: number;        // textContent 长度
}

/**
 * 使用 Readability 解析页面主体内容
 * 返回 null 表示页面不包含有效文章
 */
export function parseWithReadability(html: string, url: string): ReadabilityResult | null {
  const doc = new JSDOM(html, { url });
  const reader = new Readability(doc.window.document);
  const article = reader.parse();
  if (!article || !article.textContent || article.textContent.trim().length < 100) return null;
  return {
    title: article.title ?? '',
    content: article.content ?? '',
    textContent: article.textContent ?? '',
    excerpt: article.excerpt ?? '',
    byline: article.byline ?? null,
    siteName: article.siteName ?? null,
    length: article.textContent.length,
  };
}

/**
 * 通过 URL 模式判断页面是否为列表页
 *
 * 列表页特征：
 * - 首页（路径为 /）
 * - 分类/标签/归档等聚合路径
 * - 分页路径（/page/2, ?page=3）
 * - 搜索结果页
 * - 纯日期路径（/2026/04/ 不带 slug）
 *
 * 其他路径默认视为非列表页（交给 Readability 等后续逻辑判断 single/unknown）。
 */
export function looksLikeListUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log.debug(`looksLikeListUrl: invalid URL "${url}" → false`);
    return false;
  }

  const path = parsed.pathname.replace(/\/+$/, ''); // 去掉尾部斜杠

  // 1. 首页
  if (path === '' || path === '/') {
    log.debug(`looksLikeListUrl: "${url}" → list (homepage)`);
    return true;
  }

  // 2. 常见聚合路径关键词
  const LIST_SEGMENTS = [
    'category', 'categories', 'cat',
    'tag', 'tags', 'topic', 'topics',
    'archive', 'archives',
    'author', 'authors',
    'search', 'feed', 'rss',
    'blog',                   // /blog 通常是文章列表首页
    'news', 'posts', 'articles',
    'page',                   // /page/2
  ];

  const segments = path.split('/').filter(Boolean);
  const hasListSegment = segments.some(s => LIST_SEGMENTS.includes(s.toLowerCase()));

  if (hasListSegment) {
    log.debug(`looksLikeListUrl: "${url}" → list (segment match: ${segments.filter(s => LIST_SEGMENTS.includes(s.toLowerCase())).join(', ')})`);
    return true;
  }

  // 3. 分页查询参数
  if (parsed.searchParams.has('page') || parsed.searchParams.has('p') || parsed.searchParams.has('paged')) {
    log.debug(`looksLikeListUrl: "${url}" → list (pagination param)`);
    return true;
  }

  // 4. 纯日期路径（/2026/ 或 /2026/04/）且不带 slug
  if (/^\/\d{4}(\/\d{1,2})?(\/\d{1,2})?$/.test(path)) {
    log.debug(`looksLikeListUrl: "${url}" → list (date-only path)`);
    return true;
  }

  log.debug(`looksLikeListUrl: "${url}" → false`);
  return false;
}

export interface ExtractedMetadata {
  title: string;
  description: string;
  author?: string;
  publishedAt?: string;
  image?: string;
  keywords?: string[];
}

// 提取页面元数据
export function extractMetadata(html: string): ExtractedMetadata {
  const $ = cheerio.load(html);
  
  return {
    title: extractTitle($),
    description: extractDescription($),
    author: extractAuthor($),
    publishedAt: extractPublishedAt($),
    image: extractImage($),
    keywords: extractKeywords($),
  };
}

// 提取标题
function extractTitle($: cheerio.CheerioAPI): string {
  // 优先级顺序
  const selectors = [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'h1',
    'title',
  ];
  
  for (const selector of selectors) {
    const element = $(selector).first();
    const text = selector.startsWith('meta')
      ? element.attr('content')
      : element.text().trim();
    
    if (text && text.length > 0) {
      return text.slice(0, 200);
    }
  }
  
  return 'Untitled';
}

// 提取描述
function extractDescription($: cheerio.CheerioAPI): string {
  const selectors = [
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ];
  
  for (const selector of selectors) {
    const content = $(selector).first().attr('content');
    if (content && content.length > 0) {
      return content.slice(0, 500);
    }
  }
  
  return '';
}

// 提取作者
function extractAuthor($: cheerio.CheerioAPI): string | undefined {
  const selectors = [
    'meta[property="article:author"]',
    'meta[name="author"]',
    '[class*="author"]',
    '[class*="byline"]',
  ];
  
  for (const selector of selectors) {
    const element = $(selector).first();
    const text = selector.startsWith('meta')
      ? element.attr('content')
      : element.text().trim();
    
    if (text && text.length > 0) {
      return text.slice(0, 100);
    }
  }
  
  return undefined;
}

// 提取发布时间
function extractPublishedAt($: cheerio.CheerioAPI): string | undefined {
  const selectors = [
    'meta[property="article:published_time"]',
    'meta[name="publishedDate"]',
    'time[datetime]',
  ];
  
  for (const selector of selectors) {
    const element = $(selector).first();
    const value = selector.includes('meta')
      ? element.attr('content')
      : element.attr('datetime');
    
    if (value && value.length > 0) {
      // 尝试解析为 ISO 格式
      try {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          return date.toISOString();
        }
      } catch {}
    }
  }
  
  return undefined;
}

// 提取图片
function extractImage($: cheerio.CheerioAPI): string | undefined {
  const selectors = [
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
  ];
  
  for (const selector of selectors) {
    const content = $(selector).first().attr('content');
    if (content && content.length > 0) {
      return content;
    }
  }
  
  return undefined;
}

// 提取关键词
function extractKeywords($: cheerio.CheerioAPI): string[] {
  const keywords: string[] = [];
  
  // 从 meta 标签提取
  const metaKeywords = $('meta[name="keywords"]').attr('content');
  if (metaKeywords) {
    keywords.push(...metaKeywords.split(',').map(k => k.trim()));
  }
  
  // 从 article:tag 提取
  $('meta[property="article:tag"]').each((_, el) => {
    const tag = $(el).attr('content');
    if (tag) keywords.push(tag);
  });
  
  return [...new Set(keywords)].slice(0, 20);
}

// 提取所有链接
export function extractLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const $ = cheerio.load(html);
  const links: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      try {
        const url = new URL(href, baseUrl).href;
        
        if (!seen.has(url)) {
          seen.add(url);
          links.push({ url, text: text.slice(0, 200) });
        }
      } catch {}
    }
  });
  
  return links;
}

// 提取文本内容
export function extractText(html: string, selector?: string): string {
  const $ = cheerio.load(html);
  
  // 移除脚本和样式
  $('script, style, nav, footer, header, aside').remove();
  
  let element;
  if (selector) {
    element = $(selector);
  } else {
    // 尝试找到主要内容
    element = $('article, main, [role="main"], .content, #content').first();
    if (!element.length) {
      element = $('body');
    }
  }
  
  return element
    .text()
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

export default {
  extractMetadata,
  extractLinks,
  extractText,
};
