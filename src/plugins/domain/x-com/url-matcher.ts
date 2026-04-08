/**
 * X.com URL 匹配与页面类型检测
 */

const X_HOSTNAMES = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'];

/** 匹配 x.com / twitter.com 域名，返回优先级 3；不匹配返回 null */
export function matchUrl(url: string): number | null {
  try {
    const { hostname } = new URL(url);
    if (X_HOSTNAMES.includes(hostname)) return 3;
    return null;
  } catch {
    return null;
  }
}

/**
 * 判断页面类型：
 *  - single: /{handle}/status/{id}
 *  - list:   /{handle}  /{handle}/with_replies  /{handle}/media  /{handle}/likes 等 posts tab 相关
 *  - unknown: 其他（search, explore, settings ...）
 */
export function pageType(url: string): 'list' | 'single' | 'unknown' {
  try {
    const u = new URL(url);

    // 单条推文/post 页
    if (/^\/[^/]+\/status\/\d+/.test(u.pathname)) {
      return 'single';
    }

    // 用户主页 / posts tab 变体
    // /@handle 或 /handle（不以保留路径开头）
    const RESERVED = new Set([
      'home', 'explore', 'search', 'notifications', 'messages',
      'settings', 'i', 'login', 'signup', 'compose', 'tos', 'privacy',
      'hashtag', 'intent', 'share',
    ]);

    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return 'unknown'; // 首页

    const first = segments[0].replace(/^@/, '');
    if (RESERVED.has(first.toLowerCase())) return 'unknown';

    // /{handle} 或 /{handle}/{tab}
    const USER_TABS = new Set([
      '', 'with_replies', 'media', 'likes', 'highlights', 'articles',
    ]);
    const tab = segments[1] ?? '';
    if (segments.length <= 2 && USER_TABS.has(tab)) {
      return 'list';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 从 status URL 提取推文 ID */
export function extractPostId(url: string): string | null {
  const match = /\/status\/(\d+)/.exec(url);
  return match?.[1] ?? null;
}

/** 从 URL 提取用户 handle（不含 @） */
export function extractHandle(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    return segments[0].replace(/^@/, '');
  } catch {
    return null;
  }
}
