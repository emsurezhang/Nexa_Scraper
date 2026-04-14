/**
 * Cookie 管理模块
 * 负责 Cookie 的增删查改和持久化存储
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Cookie } from 'playwright';
import { createLogger } from '../logger.js';
import { cookieOperations } from '../db.js';

const logger = createLogger({ module: 'cookie' });

// 获取项目根目录（package.json 所在目录）
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../../');
const COOKIES_DIR = resolve(PROJECT_ROOT, 'data/cookies');

// 确保目录存在
if (!existsSync(COOKIES_DIR)) {
  mkdirSync(COOKIES_DIR, { recursive: true });
}

export interface CookieMeta {
  domain: string;
  status: 'valid' | 'expired' | 'unknown';
  itemCount: number;
  expiresAt: number | null;
  updatedAt: number;
}

// 获取 Cookie 文件路径
function getCookiePath(domain: string): string {
  // 移除协议和路径，只保留域名
  const cleanDomain = domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
  
  return resolve(COOKIES_DIR, `${cleanDomain}.json`);
}

// 解析域名
function extractDomain(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

// 保存 Cookie
export async function saveCookies(domain: string, cookies: Cookie[]): Promise<void> {
  const cookiePath = getCookiePath(domain);
  const now = Date.now();
  
  // 写入文件
  writeFileSync(cookiePath, JSON.stringify(cookies, null, 2), { mode: 0o600 });
  
  // 计算过期时间（取最晚过期的 cookie）
  let maxExpires: number | null = null;
  for (const cookie of cookies) {
    if (cookie.expires && cookie.expires > 0) {
      const expiresMs = cookie.expires * 1000;
      if (!maxExpires || expiresMs > maxExpires) {
        maxExpires = expiresMs;
      }
    }
  }
  
  // 更新元数据
  const status: CookieMeta['status'] = maxExpires && maxExpires < now ? 'expired' : 'valid';
  
  cookieOperations.save({
    domain: extractDomain(domain),
    status,
    item_count: cookies.length,
    expires_at: maxExpires,
  });
  
  logger.info(`Saved ${cookies.length} cookies for ${domain}`);
}

// 加载 Cookie
export function loadCookies(domain: string): Cookie[] | null {
  const cookiePath = getCookiePath(domain);
  
  if (!existsSync(cookiePath)) {
    return null;
  }
  
  try {
    const content = readFileSync(cookiePath, 'utf-8');
    const cookies = JSON.parse(content) as Cookie[];
    logger.debug(`Loaded ${cookies.length} cookies for ${domain}`);
    return cookies;
  } catch (error) {
    logger.error(`Failed to load cookies for ${domain}: ${error}`);
    return null;
  }
}

// 检查 Cookie 是否存在
export function hasCookies(domain: string): boolean {
  return existsSync(getCookiePath(domain));
}

// 删除 Cookie
export function deleteCookies(domain: string): void {
  const cookiePath = getCookiePath(domain);
  
  if (existsSync(cookiePath)) {
    // 删除文件
    const fs = require('fs');
    fs.unlinkSync(cookiePath);
    
    // 删除元数据
    cookieOperations.delete(extractDomain(domain));
    
    logger.info(`Deleted cookies for ${domain}`);
  }
}

// 列出所有 Cookie
export function listCookies(): CookieMeta[] {
  const metas = cookieOperations.list();
  
  return metas.map(meta => ({
    domain: meta.domain,
    status: meta.status,
    itemCount: meta.item_count,
    expiresAt: meta.expires_at,
    updatedAt: meta.updated_at,
  }));
}

// 获取 Cookie 元数据
export function getCookieMeta(domain: string): CookieMeta | null {
  const meta = cookieOperations.get(extractDomain(domain));
  
  if (!meta) return null;
  
  return {
    domain: meta.domain,
    status: meta.status,
    itemCount: meta.item_count,
    expiresAt: meta.expires_at,
    updatedAt: meta.updated_at,
  };
}

// 验证 Cookie 是否过期
export function isCookieExpired(domain: string): boolean {
  const meta = getCookieMeta(domain);
  
  if (!meta) return true;
  if (meta.status === 'expired') return true;
  if (!meta.expiresAt) return false;
  
  return Date.now() > meta.expiresAt;
}

// 对 Cookie 值进行脱敏（用于调试输出）
export function maskCookies(cookies: Cookie[]): Array<Omit<Cookie, 'value'> & { value: string }> {
  return cookies.map(cookie => ({
    ...cookie,
    value: cookie.value.slice(0, 4) + '****',
  }));
}

// 导出所有 Cookie
export function exportCookies(domains?: string[]): Record<string, Cookie[]> {
  const result: Record<string, Cookie[]> = {};
  
  if (domains && domains.length > 0) {
    // 导出指定域名
    for (const domain of domains) {
      const cookies = loadCookies(domain);
      if (cookies) {
        result[domain] = cookies;
      }
    }
  } else {
    // 导出所有
    const fs = require('fs');
    const files = fs.readdirSync(COOKIES_DIR);
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const domain = file.replace('.json', '');
        const cookies = loadCookies(domain);
        if (cookies) {
          result[domain] = cookies;
        }
      }
    }
  }
  
  return result;
}

// 导入 Cookie
export function importCookies(data: Record<string, Cookie[]>): void {
  for (const [domain, cookies] of Object.entries(data)) {
    saveCookies(domain, cookies).catch(err => {
      logger.error(`Failed to import cookies for ${domain}: ${err}`);
    });
  }
}

/**
 * 将 JSON Cookie 导出为 Netscape 格式（供 yt-dlp 等工具使用）
 * @returns 是否成功导出
 */
export function exportCookiesToNetscape(domain: string, outputPath: string): boolean {
  const cookies = loadCookies(domain);
  if (!cookies || cookies.length === 0) {
    return false;
  }

  const lines: string[] = [
    '# Netscape HTTP Cookie File',
    '# This file was generated by libcurl! Edit at your own risk.',
    '',
  ];

  for (const c of cookies) {
    const domain = (c.httpOnly ? '#HttpOnly_' : '') + c.domain;
    const domainFlag = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = Math.floor(c.expires && c.expires > 0 ? c.expires : 0);
    // Netscape 格式不允许 name/value 包含制表符或换行
    const name = c.name.replace(/[\t\n\r]/g, ' ');
    const value = c.value.replace(/[\t\n\r]/g, ' ');
    lines.push(
      [domain, domainFlag, c.path, secure, String(expires), name, value].join('\t'),
    );
  }

  try {
    writeFileSync(outputPath, lines.join('\n'), { mode: 0o600 });
    logger.info(`Exported ${cookies.length} Netscape cookies for ${domain} to ${outputPath}`);
    return true;
  } catch (error) {
    logger.error(`Failed to export Netscape cookies for ${domain}: ${error}`);
    return false;
  }
}

export default {
  save: saveCookies,
  load: loadCookies,
  has: hasCookies,
  delete: deleteCookies,
  list: listCookies,
  getMeta: getCookieMeta,
  isExpired: isCookieExpired,
  mask: maskCookies,
  export: exportCookies,
  import: importCookies,
};
