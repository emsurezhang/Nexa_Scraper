/**
 * X.com 数据提取器
 *
 * 提取策略（按优先级）：
 *   1. 从内联 `<script>` 里的 __NEXT_DATA__ / 初始化 JSON 提取结构化数据
 *   2. 从 DOM `article[data-testid="tweet"]` 节点解析
 *
 * X 采用 React + GraphQL，大部分数据通过 XHR 返回，
 * 但首屏 SSR 的 HTML 里通常含有足够的推文 DOM。
 */

import * as cheerio from 'cheerio';
import type { ListItem, SingleItem } from '../../../core/plugin-contract.js';
import { extractPostId, extractHandle } from './url-matcher.js';

/* ------------------------------------------------------------------ */
/*  List extraction (user posts tab)                                   */
/* ------------------------------------------------------------------ */

export async function extractList(html: string, url: string): Promise<ListItem[]> {
  // 尝试从内联 JSON 提取
  const fromJson = extractTweetsFromInlineJson(html);
  if (fromJson.length > 0) return fromJson;

  // 回退：从 DOM 提取
  return extractTweetsFromDom(html, url);
}

/* ------------------------------------------------------------------ */
/*  Single extraction (tweet detail page)                              */
/* ------------------------------------------------------------------ */

export async function extractSingle(html: string, url: string): Promise<SingleItem> {
  const postId = extractPostId(url) ?? `xpost_${Date.now()}`;
  const handle = extractHandle(url) ?? '';

  // 尝试从内联 JSON 提取
  const tweetData = extractMainTweetFromJson(html, postId);
  if (tweetData) return tweetData;

  // 回退：DOM 提取
  return extractSingleFromDom(html, url, postId, handle);
}

/* ================================================================== */
/*  Inline JSON extraction                                             */
/* ================================================================== */

interface TweetResult {
  id: string;
  fullText: string;
  userId: string;
  userName: string;
  screenName: string;
  createdAt: string;
  retweets: number;
  likes: number;
  replies: number;
  bookmarks: number;
  views: number;
  media?: { type: string; url: string }[];
}

/**
 * X 的 SSR HTML 有时会在 <script id="__NEXT_DATA__"> 或其他 <script> 标签中
 * 包含初始 timeline 数据。这个函数尝试提取这些数据。
 *
 * 常见路径：
 *   __NEXT_DATA__.props.pageProps.timeline.entries[].content.itemContent.tweet_results.result
 */
function extractTweetsFromInlineJson(html: string): ListItem[] {
  const items: ListItem[] = [];

  // 1. 尝试 __NEXT_DATA__
  const nextData = extractScriptJson(html, '__NEXT_DATA__');
  if (nextData) {
    const tweets = findTweetResults(nextData);
    for (const t of tweets) {
      items.push(tweetToListItem(t));
    }
    if (items.length > 0) return items;
  }

  // 2. 尝试 window.__INITIAL_STATE__ 或其他内联变量
  const patterns = [
    /window\.__INITIAL_STATE__\s*=\s*/,
    /window\.__reactRoot\s*=\s*/,
  ];
  for (const pattern of patterns) {
    const json = extractJsonAfterPattern(html, pattern);
    if (json) {
      const tweets = findTweetResults(json);
      for (const t of tweets) {
        items.push(tweetToListItem(t));
      }
      if (items.length > 0) return items;
    }
  }

  return items;
}

function extractMainTweetFromJson(html: string, postId: string): SingleItem | null {
  const nextData = extractScriptJson(html, '__NEXT_DATA__');
  if (!nextData) return null;

  const tweets = findTweetResults(nextData);
  // 找到与 postId 匹配的推文
  const main = tweets.find((t) => t.id === postId) ?? tweets[0];
  if (!main) return null;

  return tweetToSingleItem(main, postId);
}

/* ---- JSON helpers -------------------------------------------------- */

function extractScriptJson(html: string, id: string): Record<string, unknown> | null {
  const $ = cheerio.load(html);
  const script = $(`script#${id}`).html();
  if (!script) return null;
  try {
    return JSON.parse(script);
  } catch {
    return null;
  }
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

/**
 * 在嵌套 JSON 中递归查找 tweet_results.result 或 legacy 字段,
 * 将其映射为 TweetResult。
 */
function findTweetResults(obj: unknown, depth = 0): TweetResult[] {
  const results: TweetResult[] = [];
  if (depth > 20 || !obj || typeof obj !== 'object') return results;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...findTweetResults(item, depth + 1));
    }
    return results;
  }

  const rec = obj as Record<string, unknown>;

  // tweet_results.result.legacy holds the tweet data in GraphQL responses
  const tweetResult = rec.tweet_results as Record<string, unknown> | undefined;
  if (tweetResult?.result) {
    const parsed = parseTweetResult(tweetResult.result as Record<string, unknown>);
    if (parsed) {
      results.push(parsed);
      return results; // 不再递归更深
    }
  }

  for (const val of Object.values(rec)) {
    results.push(...findTweetResults(val, depth + 1));
  }
  return results;
}

function parseTweetResult(result: Record<string, unknown>): TweetResult | null {
  const legacy = result.legacy as Record<string, unknown> | undefined;
  if (!legacy) return null;

  const core = result.core as Record<string, unknown> | undefined;
  const userResults = core?.user_results as Record<string, unknown> | undefined;
  const userLegacy = (userResults?.result as Record<string, unknown>)?.legacy as
    | Record<string, unknown>
    | undefined;

  const id = (legacy.id_str as string) ?? (result.rest_id as string) ?? '';
  if (!id) return null;

  return {
    id,
    fullText: (legacy.full_text as string) ?? '',
    userId: (userLegacy?.id_str as string) ?? '',
    userName: (userLegacy?.name as string) ?? '',
    screenName: (userLegacy?.screen_name as string) ?? '',
    createdAt: (legacy.created_at as string) ?? '',
    retweets: asNumber(legacy.retweet_count),
    likes: asNumber(legacy.favorite_count),
    replies: asNumber(legacy.reply_count),
    bookmarks: asNumber(legacy.bookmark_count),
    views: asNumber((result.views as Record<string, unknown>)?.count),
    media: extractTweetMedia(legacy),
  };
}

function extractTweetMedia(
  legacy: Record<string, unknown>,
): { type: string; url: string }[] | undefined {
  const entities = legacy.extended_entities as Record<string, unknown> | undefined;
  const media = entities?.media as Record<string, unknown>[] | undefined;
  if (!media?.length) return undefined;

  return media.map((m) => ({
    type: (m.type as string) ?? 'photo',
    url: (m.media_url_https as string) ?? (m.url as string) ?? '',
  }));
}

function asNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

/* ---- Conversions --------------------------------------------------- */

function tweetToListItem(t: TweetResult): ListItem {
  return {
    id: t.id,
    url: `https://x.com/${t.screenName}/status/${t.id}`,
    title: t.fullText.slice(0, 140),
    meta: {
      author: t.userName,
      handle: t.screenName,
      createdAt: t.createdAt,
      retweets: t.retweets,
      likes: t.likes,
      replies: t.replies,
      bookmarks: t.bookmarks,
      views: t.views,
      ...(t.media ? { mediaCount: t.media.length } : {}),
    },
  };
}

function tweetToSingleItem(t: TweetResult, postId: string): SingleItem {
  const stats: Record<string, number> = {};
  if (t.retweets) stats.retweets = t.retweets;
  if (t.likes) stats.likes = t.likes;
  if (t.replies) stats.replies = t.replies;
  if (t.bookmarks) stats.bookmarks = t.bookmarks;
  if (t.views) stats.views = t.views;

  return {
    id: postId,
    url: `https://x.com/${t.screenName}/status/${t.id}`,
    title: t.fullText.slice(0, 140),
    content: t.fullText,
    publishedAt: t.createdAt || undefined,
    author: t.userName || t.screenName,
    tags: [],
    stats,
    raw: {
      handle: t.screenName,
      media: t.media,
    },
  };
}

/* ================================================================== */
/*  DOM extraction (fallback)                                          */
/* ================================================================== */

export function extractTweetsFromDom(html: string, _url: string): ListItem[] {
  const $ = cheerio.load(html);
  const items: ListItem[] = [];

  $('article[data-testid="tweet"]').each((_i, el) => {
    const $article = $(el);

    // 推文文本
    const $textDiv = $article.find('[data-testid="tweetText"]');
    const text = $textDiv.text().trim();

    // 推文链接 — 找 time 标签的父级 <a> 以获取 status URL
    const $timeLink = $article.find('time').closest('a');
    const href = $timeLink.attr('href') ?? '';
    const statusMatch = /\/([^/]+)\/status\/(\d+)/.exec(href);

    if (!statusMatch) return; // 跳过无法解析的

    const handle = statusMatch[1];
    const tweetId = statusMatch[2];

    // 时间
    const timeEl = $article.find('time');
    const datetime = timeEl.attr('datetime') ?? '';

    // 作者名
    const authorDisplayName = $article
      .find('[data-testid="User-Name"]')
      .find('span')
      .first()
      .text()
      .trim();

    items.push({
      id: tweetId,
      url: `https://x.com/${handle}/status/${tweetId}`,
      title: text.slice(0, 140) || '(no text)',
      meta: {
        author: authorDisplayName || handle,
        handle,
        createdAt: datetime,
      },
    });
  });

  return items;
}

function extractSingleFromDom(
  html: string,
  url: string,
  postId: string,
  handleFromUrl: string,
): SingleItem {
  const $ = cheerio.load(html);

  // 主推文通常是第一个 article
  const $article = $('article[data-testid="tweet"]').first();
  const text = $article.find('[data-testid="tweetText"]').text().trim();
  const datetime = $article.find('time').attr('datetime') ?? '';

  const authorDisplayName = $article
    .find('[data-testid="User-Name"]')
    .find('span')
    .first()
    .text()
    .trim();

  // og:title 可能包含有用信息
  const ogTitle = $('meta[property="og:title"]').attr('content') ?? '';
  const ogDesc = $('meta[property="og:description"]').attr('content') ?? '';

  const title = text.slice(0, 140) || ogTitle || 'Untitled';
  const content = text || ogDesc;

  return {
    id: postId,
    url,
    title,
    content,
    publishedAt: datetime || undefined,
    author: authorDisplayName || handleFromUrl,
    tags: [],
    stats: {},
    raw: {
      handle: handleFromUrl,
      ogTitle,
    },
  };
}
