/**
 * YouTube URL 匹配与页面类型检测
 */

/** 匹配 youtube.com 域名，返回优先级 3；不匹配返回 null */
export function matchUrl(url: string): number | null {
  try {
    const { hostname } = new URL(url);
    if (/^(www\.|m\.)?youtube\.com$/.test(hostname)) {
      return 3;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 判断页面类型：
 *  - single: /watch?v=xxx
 *  - list:   /@handle/videos, /channel/UC.../videos, /@handle 等
 *  - unknown: 其他
 */
export function pageType(url: string): 'list' | 'single' | 'unknown' {
  try {
    const u = new URL(url);
    // 单视频页
    if (u.pathname === '/watch' && u.searchParams.has('v')) {
      return 'single';
    }
    // 频道 videos tab  /@handle/videos  /channel/UC.../videos  /c/xxx/videos
    if (/\/(videos|streams|shorts)\/?$/i.test(u.pathname)) {
      return 'list';
    }
    // 频道主页（默认当 list，YouTube 频道首页也会展示视频）
    if (/^\/@[^/]+\/?$/.test(u.pathname) || /^\/channel\/[^/]+\/?$/.test(u.pathname)) {
      return 'list';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 从 watch URL 提取 video ID */
export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get('v');
  } catch {
    return null;
  }
}

/** 从相对路径 href 提取 video ID */
export function extractVideoIdFromPath(href: string): string | null {
  const match = /[?&]v=([a-zA-Z0-9_-]{11})/.exec(href);
  return match?.[1] ?? null;
}
