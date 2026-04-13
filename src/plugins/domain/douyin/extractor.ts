/**
 * 抖音数据提取器
 *
 * 提取策略（按优先级）：
 *   1. 从内联 <script id="RENDER_DATA"> 或 window.__INITIAL_STATE__ 提取结构化 JSON
 *   2. 从 DOM 回退解析
 *
 * 抖音服务端渲染的 HTML 包含 RENDER_DATA（URL-encoded JSON），包含完整的视频信息。
 */

import * as cheerio from 'cheerio';
import type { ListItem, SingleItem } from '../../../core/plugin-contract.js';
import { extractVideoId } from './url-matcher.js';
import { logger } from '../../../core/logger.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DouyinVideoItem {
  awemeId?: string;
  desc?: string;
  createTime?: number;
  author?: {
    uid?: string;
    nickname?: string;
    secUid?: string;
    uniqueId?: string;
  };
  statistics?: {
    diggCount?: number;
    commentCount?: number;
    collectCount?: number;
    shareCount?: number;
    playCount?: number;
  };
  duration?: number; // 毫秒
  textExtra?: { hashtagName?: string }[];
  video?: {
    cover?: { urlList?: string[] };
    playAddr?: { urlList?: string[] };
  };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** 列表页数据提取（用户主页视频列表） */
export async function extractList(html: string, _url: string): Promise<ListItem[]> {
  // 优先从内联 JSON 提取
  const fromJson = extractVideoListFromJson(html);
  if (fromJson.length > 0) return fromJson;

  // 回退：从 DOM 提取
  return extractVideoListFromDom(html);
}

/** 单视频页数据提取 */
export async function extractSingle(html: string, url: string): Promise<SingleItem> {
  const videoId = extractVideoId(url) ?? `dy_${Date.now()}`;

  // 优先从内联 JSON 提取
  const fromJson = extractSingleFromJson(html, videoId);
  logger.debug(`[extractSingle] extractSingleFromJson result: ${fromJson ? 'success' : 'null'}, videoId: ${videoId}`);
  if (fromJson) {
    logger.debug(`[extractSingle] Extracted from JSON: extract from dom.)}`);
    // 如果 JSON 提取成功但没有发布时间，尝试从 DOM 补充提取
    const domPublishedAt = extractPublishedAtFromDom(html);
    if (domPublishedAt) {
      fromJson.publishedAt = domPublishedAt;
    }
    console.log(`[extractSingle] Extracted publishedAt from DOM: ${domPublishedAt}`);
    return fromJson;
  }

  // 回退：DOM 提取
  return extractSingleFromDom(html, url, videoId);
}

/* ================================================================== */
/*  内联 JSON 提取                                                      */
/* ================================================================== */

/**
 * 抖音 SSR 页面在 <script id="RENDER_DATA"> 中包含 URL-encoded JSON。
 * 也可能在 window.__INITIAL_STATE__ 或 self.__pace_f 中。
 */
function getRenderData(html: string): Record<string, unknown> | null {
  const $ = cheerio.load(html);

  // 1. RENDER_DATA（URL-encoded JSON）
  const renderScript = $('script#RENDER_DATA').html();
  if (renderScript) {
    try {
      const decoded = decodeURIComponent(renderScript);
      return JSON.parse(decoded);
    } catch {
      // 继续
    }
  }

  // 2. window.__INITIAL_STATE__
  const stateJson = extractJsonAfterPattern(html, /window\.__INITIAL_STATE__\s*=\s*/);
  if (stateJson) return stateJson;

  // 3. C_RENDER_DATA 或 _ROUTER_DATA
  for (const id of ['C_RENDER_DATA', '_ROUTER_DATA']) {
    const script = $(`script#${id}`).html();
    if (script) {
      try {
        return JSON.parse(decodeURIComponent(script));
      } catch {
        try {
          return JSON.parse(script);
        } catch {
          // 继续
        }
      }
    }
  }

  return null;
}

/* ---- 列表提取 ------------------------------------------------------ */

function extractVideoListFromJson(html: string): ListItem[] {
  const data = getRenderData(html);
  if (!data) return [];

  const items: ListItem[] = [];

  // 在 RENDER_DATA 中递归查找 awemeList / post / aweme 数组
  const awemeList = findAwemeList(data);
  for (const aweme of awemeList) {
    const item = awemeToListItem(aweme);
    if (item) items.push(item);
  }

  return items;
}

function extractSingleFromJson(html: string, videoId: string): SingleItem | null {
  const data = getRenderData(html);
  if (!data) return null;

  // 查找与 videoId 匹配的 aweme，或取到的第一个
  const awemeList = findAwemeList(data);
  const target = awemeList.find((a) => a.awemeId === videoId) ?? awemeList[0];

  // 也可能在 awemeDetail 这个 key 下
  if (!target) {
    const detail = deepFind(data, 'awemeDetail') as DouyinVideoItem | undefined;
    if (detail) return awemeToSingleItem(detail, videoId);

    const aweme = deepFind(data, 'aweme') as DouyinVideoItem | undefined;
    if (aweme) return awemeToSingleItem(aweme, videoId);

    return null;
  }

  return awemeToSingleItem(target, videoId);
}

/* ---- aweme 查找 ---------------------------------------------------- */

/** 在嵌套 JSON 中查找所有视频条目（awemeList、post_list 等） */
function findAwemeList(obj: unknown, depth = 0): DouyinVideoItem[] {
  const results: DouyinVideoItem[] = [];
  if (depth > 15 || !obj || typeof obj !== 'object') return results;

  if (Array.isArray(obj)) {
    // 检查是否为 aweme 数组（第一个元素有 awemeId）
    if (obj.length > 0 && (obj[0] as Record<string, unknown>).awemeId) {
      for (const item of obj) {
        results.push(normalizeAweme(item as Record<string, unknown>));
      }
      return results;
    }
    for (const item of obj) {
      results.push(...findAwemeList(item, depth + 1));
    }
    return results;
  }

  const rec = obj as Record<string, unknown>;

  // 常见 key：awemeList, post_list, aweme_list
  for (const key of ['awemeList', 'post_list', 'aweme_list']) {
    if (Array.isArray(rec[key])) {
      for (const item of rec[key] as unknown[]) {
        results.push(normalizeAweme(item as Record<string, unknown>));
      }
      if (results.length > 0) return results;
    }
  }

  for (const val of Object.values(rec)) {
    results.push(...findAwemeList(val, depth + 1));
  }
  return results;
}

/** 统一 snake_case / camelCase 字段 */
function normalizeAweme(raw: Record<string, unknown>): DouyinVideoItem {
  const stats = (raw.statistics ?? raw.stats ?? {}) as Record<string, unknown>;
  const author = (raw.author ?? raw.authorInfo ?? {}) as Record<string, unknown>;
  const video = (raw.video ?? {}) as Record<string, unknown>;
  const cover = (video.cover ?? video.originCover ?? {}) as Record<string, unknown>;

  return {
    awemeId: (raw.awemeId ?? raw.aweme_id ?? raw.id) as string | undefined,
    desc: (raw.desc ?? raw.description ?? '') as string,
    createTime: (raw.createTime ?? raw.create_time) as number | undefined,
    author: {
      uid: (author.uid ?? author.id) as string | undefined,
      nickname: (author.nickname ?? author.name) as string | undefined,
      secUid: (author.secUid ?? author.sec_uid) as string | undefined,
      uniqueId: (author.uniqueId ?? author.unique_id) as string | undefined,
    },
    statistics: {
      diggCount: asNumber(stats.diggCount ?? stats.digg_count),
      commentCount: asNumber(stats.commentCount ?? stats.comment_count),
      collectCount: asNumber(stats.collectCount ?? stats.collect_count),
      shareCount: asNumber(stats.shareCount ?? stats.share_count),
      playCount: asNumber(stats.playCount ?? stats.play_count),
    },
    duration: asNumber(raw.duration ?? (video as Record<string, unknown>).duration),
    textExtra: raw.textExtra as DouyinVideoItem['textExtra'],
    video: {
      cover: { urlList: (cover.urlList ?? cover.url_list) as string[] | undefined },
      playAddr: {
        urlList: ((video.playAddr ?? video.play_addr) as Record<string, unknown> | undefined)
          ?.urlList as string[] | undefined,
      },
    },
  };
}

/* ---- 转换 ---------------------------------------------------------- */

function awemeToListItem(aweme: DouyinVideoItem): ListItem | null {
  const id = aweme.awemeId;
  if (!id) return null;

  const desc = (aweme.desc ?? '').trim();
  if (!desc) return null;

  return {
    id,
    url: `https://www.douyin.com/video/${id}`,
    title: desc.slice(0, 140),
    meta: {
      author: aweme.author?.nickname,
      createdAt: aweme.createTime
        ? new Date(aweme.createTime * 1000).toISOString()
        : undefined,
      likes: aweme.statistics?.diggCount,
      comments: aweme.statistics?.commentCount,
      shares: aweme.statistics?.shareCount,
      plays: aweme.statistics?.playCount,
      durationMs: aweme.duration,
      cover: aweme.video?.cover?.urlList?.[0],
    },
  };
}

function awemeToSingleItem(aweme: DouyinVideoItem, videoId: string): SingleItem {
  const stats: Record<string, number> = {};
  const s = aweme.statistics;
  if (s?.diggCount) stats.likes = s.diggCount;
  if (s?.commentCount) stats.comments = s.commentCount;
  if (s?.collectCount) stats.collects = s.collectCount;
  if (s?.shareCount) stats.shares = s.shareCount;
  if (s?.playCount) stats.plays = s.playCount;
  if (aweme.duration) stats.durationMs = aweme.duration;

  const tags = (aweme.textExtra ?? [])
    .map((t) => t.hashtagName)
    .filter((t): t is string => !!t);

  return {
    id: aweme.awemeId ?? videoId,
    url: `https://www.douyin.com/video/${aweme.awemeId ?? videoId}`,
    title: (aweme.desc ?? '').slice(0, 140) || 'Untitled',
    content: aweme.desc ?? '',
    publishedAt: aweme.createTime
      ? new Date(aweme.createTime * 1000).toISOString()
      : undefined,
    author: aweme.author?.nickname ?? '',
    tags,
    stats,
    raw: {
      authorUid: aweme.author?.uid,
      authorSecUid: aweme.author?.secUid,
      cover: aweme.video?.cover?.urlList?.[0],
    },
  };
}

/**
 * 从 DOM 中提取发布时间（用于补充 JSON 提取的缺失）
 */
function extractPublishedAtFromDom(html: string): string | undefined {
  const $ = cheerio.load(html);

  // 调试信息收集
  const debug: string[] = [];

  // 尝试多种选择器组合来提取发布时间
  const selectors = [
    '[data-e2e="detail-video-publish-time"]',
  ];

  for (const sel of selectors) {
    const el = $(sel).first();
    const text = el.text().trim();
    debug.push(`[extractPublishedAtFromDom] selector: ${sel}, text: "${text}"`);
    if (text && (/\d+\s*[天小时分钟周月年秒]|\d{4}[-\/]||昨天|前天|刚刚/.test(text) || text.includes('·'))) {
      debug.push(`[extractPublishedAtFromDom] selector matched time pattern: ${text}`);
      const parsed = parseRelativeTime(text);
      debug.push(`[extractPublishedAtFromDom] parseRelativeTime result: ${parsed}`);
      if (parsed) {
        logger.debug(debug.join('\n'));
        return parsed;
      }
    }
  }

  // 尝试从 script 数据中提取
  const scriptContent = $('script').map((_, el) => $(el).html()).get().join(' ');
  debug.push(`[extractPublishedAtFromDom] scriptContent length: ${scriptContent.length}`);
  const timeMatch = scriptContent.match(/"createTime"[:"]\s*(\d{10,13})/)
    || scriptContent.match(/"create_time"[:"]\s*(\d{10,13})/);
  debug.push(`[extractPublishedAtFromDom] scriptContent timeMatch: ${timeMatch ? timeMatch[0] : 'null'}`);
  if (timeMatch) {
    const timestamp = parseInt(timeMatch[1]);
    debug.push(`[extractPublishedAtFromDom] timestamp: ${timestamp}`);
    // 判断是秒还是毫秒
    const date = timestamp > 1000000000000 
      ? new Date(timestamp) 
      : new Date(timestamp * 1000);
    debug.push(`[extractPublishedAtFromDom] date: ${date.toISOString()}`);
    if (!isNaN(date.getTime())) {
      logger.debug(debug.join('\n'));
      return date.toISOString();
    }
  }

  debug.push('[extractPublishedAtFromDom] No publishedAt found');
  logger.debug(debug.join('\n'));
  return undefined;
}

/* ================================================================== */
/*  DOM 回退提取                                                        */
/* ================================================================== */

function extractVideoListFromDom(html: string): ListItem[] {
  const $ = cheerio.load(html);
  const items: ListItem[] = [];
  const seen = new Set<string>();

  // 匹配所有指向 /video/ 或 /note/ 的 <a> 链接
  $('a[href*="/video/"], a[href*="/note/"]').each((_i, el) => {
    const $el = $(el);
    const href = $el.attr('href') ?? '';
    const videoId = extractVideoIdFromHref(href);
    if (!videoId || seen.has(videoId)) return;
    seen.add(videoId);

    // 标题提取优先级：
    //   1. <img alt="...">（封面图 alt 属性，通常包含完整描述）
    //   2. <a> 内最后一个 <p>（抖音用户主页结构中末尾 <p> 是标题）
    //   3. <a> 的 title 属性
    const imgAlt = $el.find('img[alt]').first().attr('alt') ?? '';
    const lastP = $el.find('p').last().text().trim();
    const title = imgAlt || lastP || $el.attr('title') || '';

    const trimmedTitle = title.slice(0, 140);
    if (!trimmedTitle) return;

    items.push({
      id: videoId,
      url: `https://www.douyin.com/video/${videoId}`,
      title: trimmedTitle,
    });
  });

  return items;
}

function extractSingleFromDom(html: string, url: string, videoId: string): SingleItem {
  const $ = cheerio.load(html);

  // 标题：从 [data-e2e="detail-video-info"] h1 提取，去除 hashtag 链接
  let desc = '';
  const $h1 = $('[data-e2e="detail-video-info"] h1').first();
  if ($h1.length) {
    const $clone = $h1.clone();
    $clone.find('a').remove(); // 去除 #hashtag 链接
    desc = $clone.text().replace(/\s+/g, ' ').trim();
  }
  if (!desc) {
    desc = $('[data-e2e="video-desc"]').text().trim()
      || $('.video-info-detail').text().trim()
      || '';
  }

  // 标签：从 h1 内的 hashtag 链接提取
  const tags: string[] = [];
  $h1.find('a[href*="/search/"]').each((_i, el) => {
    const tag = $(el).text().trim().replace(/^#/, '');
    if (tag) tags.push(tag);
  });

  // 作者
  const author = $('[data-e2e="user-info"] a[href*="/user/"]').first().text().trim()
    || $('[data-e2e="video-author-name"]').text().trim()
    || '';

  // 发布时间：从 DOM 提取
  const publishedAt = extractPublishedAtFromDom(html);

  const ogTitle = $('meta[property="og:title"]').attr('content') ?? '';
  const ogDesc = $('meta[property="og:description"]').attr('content') ?? '';

  const title = desc.slice(0, 140) || ogTitle || 'Untitled';
  const content = desc || ogDesc;

  return {
    id: videoId,
    url,
    title,
    content,
    publishedAt,
    author,
    tags,
    stats: {},
    raw: {},
  };
}

/* ================================================================== */
/*  时间解析工具                                                        */
/* ================================================================== */

/**
 * 解析相对时间文本为标准 ISO 格式
 * 支持格式: "1天前", "2小时前", "30分钟前", "1周前", "1个月前" 等
 */
function parseRelativeTime(timeText: string, referenceDate: Date = new Date()): string | undefined {
  if (!timeText) return undefined;

  // 清理文本，移除前缀如 "· "
  const cleanText = timeText.replace(/^[·\s]+/, '').trim();
  if (!cleanText) return undefined;

  // 优先解析绝对日期+时间格式 (YYYY-MM-DD HH:mm 或 YYYY/MM/DD HH:mm)
  const absDateTimeMatch = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[\sT]+(\d{1,2}):(\d{1,2})/.exec(cleanText);
  if (absDateTimeMatch) {
    const [, year, month, day, hour, minute] = absDateTimeMatch;
    // 默认东八区（中国时间）
    const date = new Date(Date.UTC(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour) - 8, // 转为本地时间
      parseInt(minute),
      0,
      0
    ));
    return date.toISOString();
  }

  // 只日期 (YYYY-MM-DD, YYYY/MM/DD)
  const absoluteMatch = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(cleanText);
  if (absoluteMatch) {
    const [, year, month, day] = absoluteMatch;
    // 默认东八区 00:00
    const date = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), 0 - 8, 0, 0, 0));
    return date.toISOString();
  }

  const result = new Date(referenceDate);
  let matched = false;

  // 匹配 "X秒前"
  const secondsMatch = /(\d+)\s*秒前/.exec(cleanText);
  if (secondsMatch) {
    result.setSeconds(result.getSeconds() - parseInt(secondsMatch[1]));
    matched = true;
  }

  // 匹配 "X分钟前"
  const minutesMatch = /(\d+)\s*分钟前/.exec(cleanText);
  if (minutesMatch) {
    result.setMinutes(result.getMinutes() - parseInt(minutesMatch[1]));
    matched = true;
  }

  // 匹配 "X小时前" / "X钟头前"
  const hoursMatch = /(\d+)\s*小时前|(\d+)\s*钟头前/.exec(cleanText);
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1] || hoursMatch[2]);
    result.setHours(result.getHours() - hours);
    matched = true;
  }

  // 匹配 "X天前" / "X日前"
  const daysMatch = /(\d+)\s*天前|(\d+)\s*日前/.exec(cleanText);
  if (daysMatch) {
    const days = parseInt(daysMatch[1] || daysMatch[2]);
    result.setDate(result.getDate() - days);
    matched = true;
  }

  // 匹配 "X周前" / "X星期前" / "X礼拜前"
  const weeksMatch = /(\d+)\s*周前|(\d+)\s*星期前|(\d+)\s*礼拜前/.exec(cleanText);
  if (weeksMatch) {
    const weeks = parseInt(weeksMatch[1] || weeksMatch[2] || weeksMatch[3]);
    result.setDate(result.getDate() - weeks * 7);
    matched = true;
  }

  // 匹配 "X个月前"
  const monthsMatch = /(\d+)\s*个月前/.exec(cleanText);
  if (monthsMatch) {
    result.setMonth(result.getMonth() - parseInt(monthsMatch[1]));
    matched = true;
  }

  // 匹配 "X年前"
  const yearsMatch = /(\d+)\s*年前/.exec(cleanText);
  if (yearsMatch) {
    result.setFullYear(result.getFullYear() - parseInt(yearsMatch[1]));
    matched = true;
  }

  // 匹配 "昨天"
  if (/昨天/.test(cleanText)) {
    result.setDate(result.getDate() - 1);
    matched = true;
  }

  // 匹配 "前天"
  if (/前天/.test(cleanText)) {
    result.setDate(result.getDate() - 2);
    matched = true;
  }

  // 匹配 "刚刚"
  if (/刚刚/.test(cleanText)) {
    matched = true;
  }

  return matched ? result.toISOString() : undefined;
}

/* ================================================================== */
/*  工具方法                                                            */
/* ================================================================== */

function extractVideoIdFromHref(href: string): string | null {
  const match = /\/(video|note)\/(\d+)/.exec(href);
  return match?.[2] ?? null;
}

function extractJsonAfterPattern(
  html: string,
  pattern: RegExp,
): Record<string, unknown> | null {
  const match = pattern.exec(html);
  if (!match) return null;

  const startIdx = match.index + match[0].length;
  return extractBalancedJson(html, startIdx);
}

function extractBalancedJson(html: string, startIdx: number): Record<string, unknown> | null {
  if (html[startIdx] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < html.length; i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(startIdx, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function asNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

/** 在嵌套对象中查找第一个匹配 key 的值（BFS，深度限制） */
function deepFind(obj: unknown, targetKey: string, maxDepth = 10): unknown {
  const queue: { val: unknown; depth: number }[] = [{ val: obj, depth: 0 }];

  while (queue.length > 0) {
    const { val, depth } = queue.shift()!;
    if (depth > maxDepth || !val || typeof val !== 'object') continue;

    if (!Array.isArray(val)) {
      const record = val as Record<string, unknown>;
      if (targetKey in record) return record[targetKey];
      for (const v of Object.values(record)) {
        queue.push({ val: v, depth: depth + 1 });
      }
    } else {
      for (const item of val) {
        queue.push({ val: item, depth: depth + 1 });
      }
    }
  }
  return undefined;
}
