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

  const publishedAt = extractPublishDate(initialData);

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
/*  工具方法                                                            */
/* ================================================================== */

function ogMeta(html: string, property: string): string | undefined {
  const $ = cheerio.load(html);
  return $(`meta[property="${property}"]`).attr('content') || undefined;
}

function extractPublishDate(data: Record<string, unknown> | null): string | undefined {
  if (!data) return undefined;
  const dateText = deepFind(data, 'dateText');
  if (dateText && typeof dateText === 'object') {
    const st = (dateText as { simpleText?: string }).simpleText;
    if (st) return st;
  }
  const publishDate = deepFind(data, 'publishDate');
  if (typeof publishDate === 'string') return publishDate;
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
