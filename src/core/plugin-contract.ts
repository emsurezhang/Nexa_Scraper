/**
 * 插件系统核心接口定义
 * 所有 domain 插件必须实现 NexaPlugin 接口
 */

import type { Page } from 'playwright';

/** 插件元信息 */
export interface PluginMeta {
  name: string;
  version: string;
  domains: string[];
  priority: number;
  author?: string;
  requiresLogin?: boolean;
}

/** 登录状态 */
export type LoginState = 'logged-in' | 'logged-out' | 'unknown';

/** 列表项 */
export interface ListItem {
  id: string;
  url: string;
  title?: string;
  meta?: Record<string, unknown>;
}

/** 单内容项 */
export interface SingleItem {
  id: string;
  url: string;
  title: string;
  content: string;
  transcript?: string;
  publishedAt?: string;
  author?: string;
  tags?: string[];
  stats?: Record<string, number>;
  raw?: Record<string, unknown>;
}

/** 媒体信息 */
export interface MediaInfo {
  audioUrl?: string;
  videoUrl?: string;
  format: string;
  durationSec?: number;
}

/** 抓取选项 */
export interface FetchOptions {
  format?: 'raw' | 'delta' | 'full';
  limit?: number;
  debug?: boolean;
  debugDir?: string;
  screenshot?: 'none' | 'viewport' | 'full';
  proxy?: string;
  headless?: boolean;
  plugin?: string | null;
  timeout?: number;
}

/** 抓取结果 */
export interface FetchResult {
  id: string;
  url: string;
  data: SingleItem | ListItem[];
  fetchedAt: string;
  plugin: string;
  pageType: 'list' | 'single';
}

/** 所有插件必须实现的接口 */
export interface NexaPlugin {
  /** 插件元信息 */
  meta: PluginMeta;

  /** URL 匹配：返回 0-9 优先级（0最高），不匹配返回 null */
  matchUrl(url: string): number | null;

  /** 判断页面类型 */
  pageType(url: string, html: string): 'list' | 'single' | 'unknown';

  /** 等待页面动态内容加载完成 */
  waitForContent(page: Page): Promise<void>;

  /** 列表页数据提取 */
  extractList(html: string, url: string): Promise<ListItem[]>;

  /** 单内容页数据提取 */
  extractSingle(html: string, url: string): Promise<SingleItem>;

  /** 判断当前页面登录状态（可选） */
  checkLoginState?(page: Page): Promise<LoginState>;

  /** 媒体文件抓取（可选，适用于视频网站） */
  fetchMedia?(page: Page, url: string): Promise<MediaInfo>;
}

/** 通用插件接口（兜底解析） */
export interface GeneralPlugin extends NexaPlugin {
  meta: PluginMeta & { name: 'general' };
}
