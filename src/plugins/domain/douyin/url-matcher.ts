/**
 * 抖音 URL 匹配与页面类型检测
 */

const DOUYIN_HOSTNAMES = [
  'douyin.com',
  'www.douyin.com',
  'm.douyin.com',
];

/** 匹配 douyin.com 域名，返回优先级 3；不匹配返回 null */
export function matchUrl(url: string): number | null {
  try {
    const { hostname } = new URL(url);
    if (DOUYIN_HOSTNAMES.includes(hostname)) return 3;
    return null;
  } catch {
    return null;
  }
}

/**
 * 判断页面类型：
 *  - single: /video/{id}  或  /note/{id}
 *  - list:   /user/{uid}  或  /@{handle}
 *  - unknown: 其他（首页、搜索、热点话题等）
 */
export function pageType(url: string): 'list' | 'single' | 'unknown' {
  try {
    const u = new URL(url);

    // 单条视频/笔记页
    if (/^\/(video|note)\/\d+/.test(u.pathname)) {
      return 'single';
    }

    // 用户主页
    if (/^\/user\/[A-Za-z0-9_-]+/.test(u.pathname)) {
      return 'list';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 从视频 URL 提取视频 ID */
export function extractVideoId(url: string): string | null {
  const match = /\/(video|note)\/(\d+)/.exec(url);
  return match?.[2] ?? null;
}

/** 从用户主页 URL 提取用户 ID */
export function extractUserId(url: string): string | null {
  const match = /\/user\/([A-Za-z0-9_-]+)/.exec(url);
  return match?.[1] ?? null;
}
