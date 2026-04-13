/**
 * YouTube 数据提取器
 *
 * 提取策略（按优先级）：
 *   1. 从内联 ytInitialData / ytInitialPlayerResponse JSON 提取结构化数据
 *   2. 从 DOM 回退解析
 *
 * YouTube 页面会内联大量 JSON 数据供客户端 hydration，
 * 这些数据比 DOM 更可靠、更完整。
 */

import * as cheerio from 'cheerio';
import type { ListItem, SingleItem, MediaInfo } from '../../../core/plugin-contract.js';
import { extractVideoId, extractVideoIdFromPath } from './url-matcher.js';
import { logger } from '../../../core/logger.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface YtVideoRenderer {
  videoId?: string;
  title?: { runs?: { text: string }[]; simpleText?: string };
  publishedTimeText?: { simpleText?: string };
  viewCountText?: { simpleText?: string; runs?: { text: string }[] };
  lengthText?: { simpleText?: string };
  ownerText?: { runs?: { text: string }[] };
  descriptionSnippet?: { runs?: { text: string }[] };
  thumbnail?: { thumbnails?: { url: string; width: number; height: number }[] };
}

interface YtRichItem {
  richItemRenderer?: { content?: { videoRenderer?: YtVideoRenderer } };
}

interface YtTab {
  tabRenderer?: {
    title?: string;
    selected?: boolean;
    content?: {
      richGridRenderer?: { contents?: YtRichItem[] };
      sectionListRenderer?: {
        contents?: {
          itemSectionRenderer?: {
            contents?: { gridRenderer?: { items?: { gridVideoRenderer?: YtVideoRenderer }[] } }[];
          };
        }[];
      };
    };
  };
}

interface YtStreamingFormat {
  itag: number;
  url?: string;
  signatureCipher?: string;
  mimeType: string;
  bitrate: number;
  contentLength?: string;
  approxDurationMs?: string;
  audioQuality?: string;
  audioSampleRate?: string;
}

interface YtVideoDetails {
  videoId?: string;
  title?: string;
  shortDescription?: string;
  author?: string;
  channelId?: string;
  lengthSeconds?: string;
  viewCount?: string;
  keywords?: string[];
  isLiveContent?: boolean;
  thumbnail?: { thumbnails?: { url: string }[] };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** 列表页数据提取 */
export async function extractList(html: string, _url: string): Promise<ListItem[]> {
  // 优先从 ytInitialData 提取（更可靠）
  const initialData = extractYtInitialData(html);
  if (initialData) {
    const items = parseVideoListFromInitialData(initialData);
    if (items.length > 0) return items;
  }

  // 回退：从 DOM 提取
  return parseVideoListFromDom(html);
}

/** 单视频页数据提取 */
export async function extractSingle(html: string, url: string): Promise<SingleItem> {
  logger.debug('Extracting single item...');
  const videoId = extractVideoId(url) ?? `yt_${Date.now()}`;

  // 从 ytInitialPlayerResponse / ytInitialData 提取
  const playerResponse = extractYtPlayerResponse(html);
  const initialData = extractYtInitialData(html);

  const videoDetails = playerResponse?.videoDetails as YtVideoDetails | undefined;

  const title =
    videoDetails?.title ??
    ogMeta(html, 'og:title') ??
    'Untitled';

  const description =
    videoDetails?.shortDescription ??
    ogMeta(html, 'og:description') ??
    '';

  const author =
    videoDetails?.author ??
    ogMeta(html, 'og:site_name') ??
    '';

  const publishedAt = extractPublishDate(initialData, html);

  const durationSec = videoDetails?.lengthSeconds
    ? parseInt(videoDetails.lengthSeconds, 10)
    : undefined;

  const viewCount = videoDetails?.viewCount
    ? parseInt(videoDetails.viewCount, 10)
    : undefined;

  const stats: Record<string, number> = {};
  if (viewCount !== undefined && !isNaN(viewCount)) stats.views = viewCount;
  if (durationSec !== undefined && !isNaN(durationSec)) stats.durationSec = durationSec;

  // 从 initialData 中提取 likes
  const likes = extractLikes(initialData);
  if (likes !== undefined) stats.likes = likes;

  const tags = videoDetails?.keywords?.slice(0, 30) ?? [];

  return {
    id: videoId,
    url,
    title,
    content: description,
    publishedAt,
    author,
    tags,
    stats,
    raw: {
      channelId: videoDetails?.channelId,
      isLive: videoDetails?.isLiveContent,
      thumbnail: videoDetails?.thumbnail?.thumbnails?.at(-1)?.url,
    },
  };
}

/** 从 HTML 中提取最佳音频流信息（供 fetchMedia 使用） */
export function extractMediaInfo(html: string): MediaInfo {
  const pr = extractYtPlayerResponse(html);
  if (!pr) throw new Error('Failed to extract audio stream info');
  return pickBestAudio(pr);
}

/* ================================================================== */
/*  ytInitialData / ytInitialPlayerResponse 提取                       */
/* ================================================================== */

function extractYtInitialData(html: string): Record<string, unknown> | null {
  return extractJsonVar(html, 'ytInitialData');
}

function extractYtPlayerResponse(html: string): Record<string, unknown> | null {
  return extractJsonVar(html, 'ytInitialPlayerResponse');
}

/**
 * 从 HTML 中提取 `var xxx = {...};` 形式的 JSON 变量。
 * YouTube 页面会内联大量数据供客户端 hydration。
 */
function extractJsonVar(html: string, varName: string): Record<string, unknown> | null {
  const patterns = [
    new RegExp(`var\\s+${varName}\\s*=\\s*`),
    new RegExp(`window\\["${varName}"\\]\\s*=\\s*`),
    new RegExp(`${varName}\\s*=\\s*`),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match) continue;

    const startIdx = match.index + match[0].length;
    const json = extractBalancedJson(html, startIdx);
    if (json) {
      try {
        return JSON.parse(json);
      } catch {
        // 继续尝试下一个 pattern
      }
    }
  }
  return null;
}

/** 从 startIdx 开始提取一个完整的 { ... } JSON 块 */
function extractBalancedJson(html: string, startIdx: number): string | null {
  if (html[startIdx] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < html.length; i++) {
    const ch = html[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return html.slice(startIdx, i + 1);
      }
    }
  }
  return null;
}

/* ================================================================== */
/*  从 ytInitialData 解析视频列表                                       */
/* ================================================================== */

function parseVideoListFromInitialData(data: Record<string, unknown>): ListItem[] {
  const items: ListItem[] = [];

  const tabs = dig(data, 'contents', 'twoColumnBrowseResultsRenderer', 'tabs') as
    | YtTab[]
    | undefined;

  if (Array.isArray(tabs)) {
    for (const tab of tabs) {
      const gridContents = tab.tabRenderer?.content?.richGridRenderer?.contents;
      if (gridContents) {
        for (const item of gridContents) {
          const vr = item.richItemRenderer?.content?.videoRenderer;
          if (vr) {
            const parsed = videoRendererToListItem(vr);
            if (parsed) items.push(parsed);
          }
        }
      }

      // 兼容旧版 grid 布局
      const sectionContents = tab.tabRenderer?.content?.sectionListRenderer?.contents;
      if (sectionContents) {
        for (const section of sectionContents) {
          const isr = (section as Record<string, unknown>).itemSectionRenderer as
            | { contents?: { gridRenderer?: { items?: { gridVideoRenderer?: YtVideoRenderer }[] } }[] }
            | undefined;
          if (isr?.contents) {
            for (const c of isr.contents) {
              const gridItems = c.gridRenderer?.items;
              if (gridItems) {
                for (const gi of gridItems) {
                  if (gi.gridVideoRenderer) {
                    const parsed = videoRendererToListItem(gi.gridVideoRenderer);
                    if (parsed) items.push(parsed);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // 搜索更深层的嵌套（YouTube 经常改结构）
  if (items.length === 0) {
    findVideoRenderers(data, items, 0);
  }

  return items;
}

/** 递归搜索 videoRenderer / gridVideoRenderer 节点 */
function findVideoRenderers(
  obj: unknown,
  results: ListItem[],
  depth: number,
): void {
  if (depth > 15 || !obj || typeof obj !== 'object') return;

  const record = obj as Record<string, unknown>;

  if (record.videoRenderer) {
    const parsed = videoRendererToListItem(record.videoRenderer as YtVideoRenderer);
    if (parsed) results.push(parsed);
    return;
  }
  if (record.gridVideoRenderer) {
    const parsed = videoRendererToListItem(record.gridVideoRenderer as YtVideoRenderer);
    if (parsed) results.push(parsed);
    return;
  }

  for (const val of Object.values(record)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        findVideoRenderers(item, results, depth + 1);
      }
    } else if (val && typeof val === 'object') {
      findVideoRenderers(val, results, depth + 1);
    }
  }
}

function videoRendererToListItem(vr: YtVideoRenderer): ListItem | null {
  const videoId = vr.videoId;
  if (!videoId) return null;

  const title =
    vr.title?.runs?.map((r) => r.text).join('') ?? vr.title?.simpleText ?? '';

  const viewCountText =
    vr.viewCountText?.simpleText ??
    vr.viewCountText?.runs?.map((r) => r.text).join('') ??
    '';

  return {
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    meta: {
      publishedTime: vr.publishedTimeText?.simpleText,
      viewCount: viewCountText,
      duration: vr.lengthText?.simpleText,
      thumbnail: vr.thumbnail?.thumbnails?.at(-1)?.url,
    },
  };
}

/* ================================================================== */
/*  DOM 回退解析                                                        */
/* ================================================================== */

function parseVideoListFromDom(html: string): ListItem[] {
  const $ = cheerio.load(html);
  const items: ListItem[] = [];

  $('a#video-title-link, a#video-title').each((_i, el) => {
    const $el = $(el);
    const href = $el.attr('href') ?? '';
    const title = $el.text().trim() || $el.attr('title') || '';
    const videoId = extractVideoIdFromPath(href);

    if (videoId) {
      items.push({
        id: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title,
      });
    }
  });

  return items;
}

/* ================================================================== */
/*  音频流选择                                                          */
/* ================================================================== */

function pickBestAudio(playerResponse: Record<string, unknown>): MediaInfo {
  const streamingData = playerResponse.streamingData as
    | { adaptiveFormats?: YtStreamingFormat[]; formats?: YtStreamingFormat[] }
    | undefined;

  if (!streamingData) {
    throw new Error('No streamingData in player response');
  }

  const audioFormats = (streamingData.adaptiveFormats ?? []).filter(
    (f) => f.mimeType.startsWith('audio/'),
  );

  if (audioFormats.length === 0) {
    const mixed = streamingData.formats?.[0];
    if (mixed?.url) {
      const durMs = mixed.approxDurationMs ? parseInt(mixed.approxDurationMs, 10) : undefined;
      return {
        audioUrl: mixed.url,
        format: mixed.mimeType,
        durationSec: durMs ? Math.round(durMs / 1000) : undefined,
      };
    }
    throw new Error('No audio streams found');
  }

  audioFormats.sort((a, b) => b.bitrate - a.bitrate);
  const best = audioFormats[0];

  if (!best.url) {
    throw new Error('Audio stream URL requires signature deciphering (not supported)');
  }

  const durMs = best.approxDurationMs ? parseInt(best.approxDurationMs, 10) : undefined;

  return {
    audioUrl: best.url,
    format: best.mimeType,
    durationSec: durMs ? Math.round(durMs / 1000) : undefined,
  };
}

/* ================================================================== */
/*  时间解析工具                                                        */
/* ================================================================== */

/**
 * 解析中文日期格式为标准 ISO 格式
 * 支持格式: "2026年4月13日", "2026/04/13", "2026-04-13", "Apr 13, 2026" 等
 * 也支持相对时间: "2天前", "1周前" 等
 */
function parseChineseDate(dateText: string, referenceDate: Date = new Date()): string | undefined {
  if (!dateText) return undefined;

  const cleanText = dateText.trim();
  if (!cleanText) return undefined;

  // 解析中文日期格式: "2026年4月13日"
  const chineseMatch = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(cleanText);
  if (chineseMatch) {
    const [, year, month, day] = chineseMatch;
    // Return as YYYY-MM-DD string
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // 解析标准日期格式: "2026-04-13" 或 "2026/04/13"
  const isoMatch = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(cleanText);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // 解析英文日期格式: "Apr 13, 2026" 或 "April 13, 2026"
  const englishMatch = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(cleanText);
  if (englishMatch) {
    const date = new Date(cleanText);
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  // 解析相对时间
  const result = new Date(referenceDate);
  let matched = false;

  // 匹配 "X秒前" / "X seconds ago"
  const secondsMatch = /(\d+)\s*秒前|(\d+)\s*seconds?\s+ago/i.exec(cleanText);
  if (secondsMatch) {
    const seconds = parseInt(secondsMatch[1] || secondsMatch[2]);
    result.setSeconds(result.getSeconds() - seconds);
    matched = true;
  }

  // 匹配 "X分钟前" / "X minutes ago"
  const minutesMatch = /(\d+)\s*分钟前|(\d+)\s*minutes?\s+ago/i.exec(cleanText);
  if (minutesMatch) {
    const minutes = parseInt(minutesMatch[1] || minutesMatch[2]);
    result.setMinutes(result.getMinutes() - minutes);
    matched = true;
  }

  // 匹配 "X小时前" / "X hours ago" / "X钟头前"
  const hoursMatch = /(\d+)\s*小时前|(\d+)\s*hours?\s+ago|(\d+)\s*钟头前/i.exec(cleanText);
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1] || hoursMatch[2] || hoursMatch[3]);
    result.setHours(result.getHours() - hours);
    matched = true;
  }

  // 匹配 "X天前" / "X days ago" / "X日前"
  const daysMatch = /(\d+)\s*天前|(\d+)\s*days?\s+ago|(\d+)\s*日前/i.exec(cleanText);
  if (daysMatch) {
    const days = parseInt(daysMatch[1] || daysMatch[2] || daysMatch[3]);
    result.setDate(result.getDate() - days);
    matched = true;
  }

  // 匹配 "X周前" / "X weeks ago" / "X星期前" / "X礼拜前"
  const weeksMatch = /(\d+)\s*周前|(\d+)\s*weeks?\s+ago|(\d+)\s*星期前|(\d+)\s*礼拜前/i.exec(cleanText);
  if (weeksMatch) {
    const weeks = parseInt(weeksMatch[1] || weeksMatch[2] || weeksMatch[3] || weeksMatch[4]);
    result.setDate(result.getDate() - weeks * 7);
    matched = true;
  }

  // 匹配 "X个月前" / "X months ago"
  const monthsMatch = /(\d+)\s*个月前|(\d+)\s*months?\s+ago/i.exec(cleanText);
  if (monthsMatch) {
    const months = parseInt(monthsMatch[1] || monthsMatch[2]);
    result.setMonth(result.getMonth() - months);
    matched = true;
  }

  // 匹配 "X年前" / "X years ago"
  const yearsMatch = /(\d+)\s*年前|(\d+)\s*years?\s+ago/i.exec(cleanText);
  if (yearsMatch) {
    const years = parseInt(yearsMatch[1] || yearsMatch[2]);
    result.setFullYear(result.getFullYear() - years);
    matched = true;
  }

  // 匹配 "昨天" / "yesterday"
  if (/昨天|yesterday/i.test(cleanText)) {
    result.setDate(result.getDate() - 1);
    matched = true;
  }

  // 匹配 "前天" / "day before yesterday"
  if (/前天|day before yesterday/i.test(cleanText)) {
    result.setDate(result.getDate() - 2);
    matched = true;
  }

  // 匹配 "刚刚" / "just now"
  if (/刚刚|just now/i.test(cleanText)) {
    matched = true;
  }

  return matched ? result.toISOString() : undefined;
}

/**
 * 从 DOM HTML 中提取发布日期
 */
function extractPublishDateFromDom(html: string): string | undefined {
  const $ = cheerio.load(html);

  // 1. 尝试从 yt-formatted-string#info 提取（YouTube 视频页面上方信息区）
  const infoText = $('yt-formatted-string#info').text().trim();
  if (infoText) {
    // 提取日期部分，通常是第一个 span 的内容
    const dateMatch = /(\d{4}年\d{1,2}月\d{1,2}日)/.exec(infoText);    
    if (dateMatch) {
      logger.debug(`[extractSingle] Extracted publish date from yt-formatted-string#info: ${dateMatch[1]}`);
      const parsed = parseChineseDate(dateMatch[1]);
      logger.debug(`[extractSingle] Extracted publish date from yt-formatted-string#info: ${dateMatch[1]} -> ${parsed}`);
      if (parsed) return parsed;
    }
  }

  // 2. 尝试从 #info-strings yt-formatted-string 提取（频道视频列表页）
  const infoStrings = $('#info-strings yt-formatted-string').first().text().trim()
    || $('#info-strings').text().trim();
  if (infoStrings) {
    logger.debug(`[extractSingle] Extracted info-strings text: ${infoStrings}`);
    const parsed = parseChineseDate(infoStrings);
    logger.debug(`[extractSingle] Extracted publish date from #info-strings: ${infoStrings} -> ${parsed}`);
    if (parsed) return parsed;
  }

  // 3. 尝试从 #date 提取
  const dateEl = $('#date').text().trim()
    || $('[id="date"]').first().text().trim();
  if (dateEl) {
    logger.debug(`[extractSingle] Extracted #date text: ${dateEl}`);
    const parsed = parseChineseDate(dateEl);
    logger.debug(`[extractSingle] Extracted publish date from #date: ${dateEl} -> ${parsed}`);
    if (parsed) return parsed;
  }

  // 4. 尝试从 meta 标签提取
  const metaDate = $('meta[itemprop="datePublished"]').attr('content')
    || $('meta[property="og:video:release_date"]').attr('content');
  if (metaDate) {
    logger.debug(`[extractSingle] Extracted meta publish date: ${metaDate}`);
    const date = new Date(metaDate);
    if (!isNaN(date.getTime())) {
      logger.debug(`[extractSingle] Extracted publish date from meta tag: ${metaDate} -> ${date.toISOString()}`);
      return date.toISOString();
    }
  }

  // 5. 尝试从 ytd-watch-info-text 提取
  const watchInfoText = $('ytd-watch-info-text').text().trim()
    || $('.ytd-watch-info-text').text().trim();
  if (watchInfoText) {
    logger.debug(`[extractSingle] Extracted ytd-watch-info-text: ${watchInfoText}`);
    const dateMatch = /(\d{4}年\d{1,2}月\d{1,2}日)/.exec(watchInfoText)
      || /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/.exec(watchInfoText);
    if (dateMatch) {
      const parsed = parseChineseDate(dateMatch[1]);
      logger.debug(`[extractSingle] Extracted publish date from ytd-watch-info-text: ${dateMatch[1]} -> ${parsed}`);
      if (parsed) return parsed;
    }
  }

  return undefined;
}

/* ================================================================== */
/*  工具方法                                                            */
/* ================================================================== */

function ogMeta(html: string, property: string): string | undefined {
  const $ = cheerio.load(html);
  return $(`meta[property="${property}"]`).attr('content') || undefined;
}

function extractPublishDate(data: Record<string, unknown> | null, html?: string): string | undefined {
  logger.debug('Extracting publish date...');
  // 1. 首先尝试从 JSON 数据提取
  if (data) {
    const dateText = deepFind(data, 'dateText');
    logger.debug(`[extractSingle] Extracted dateText from JSON: ${dateText}`);
    if (dateText && typeof dateText === 'object') {
      const st = (dateText as { simpleText?: string }).simpleText;
      logger.debug(`[extractSingle] Extracted simpleText from dateText: ${st}`);
      if (st) {
        const parsed = parseChineseDate(st);
        logger.debug(`[extractSingle] Parsed publish date from dateText: ${st} -> ${parsed}`);
        if (parsed) return parsed;
      }
    }
    const publishDate = deepFind(data, 'publishDate');
    if (typeof publishDate === 'string') {
      const date = new Date(publishDate);
      if (!isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  }

  // 2. 如果 JSON 中没有，尝试从 DOM HTML 提取
  if (html) {
    const domDate = extractPublishDateFromDom(html);
    if (domDate) return domDate;
  }

  return undefined;
}

function extractLikes(data: Record<string, unknown> | null): number | undefined {
  if (!data) return undefined;
  // likes 数据嵌套较深且 YouTube 经常改结构，暂不提取
  return undefined;
}

/** 安全地沿着 key 路径取值 */
function dig(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
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
