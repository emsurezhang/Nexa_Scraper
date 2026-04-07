/**
 * Cookies 命令组
 * 管理 Cookie 的添加、列出、验证、删除等操作
 */

import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { type Cookie } from 'playwright';
import { createInterface } from 'readline/promises';
import { createLogger } from '../../core/logger.js';
import { browserManager, createPage } from '../../core/capabilities/browser.js';
import {
  saveCookies,
  loadCookies,
  deleteCookies,
  listCookies,
  getCookieMeta,
  exportCookies,
  importCookies as importCookiesFunc,
  maskCookies,
} from '../../core/capabilities/cookie-manager.js';

const logger = createLogger({ module: 'cli:cookies' });

async function readLineInput(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function runInteractiveCookieCapture(
  domain: string,
  url: string,
  headless: boolean
): Promise<void> {
  logger.info(`Opening browser for ${domain}...`);

  await browserManager.launch({
    headless,
  });

  const pageWrapper = await createPage(browserManager);
  const { page, context } = pageWrapper;

  try {
    await pageWrapper.injectStealth();

    await page.goto(url);

    console.log('\n浏览器已打开，请完成登录。');
    await readLineInput('登录完成后，按回车键保存 Cookie...');

    const cookies = await context.cookies();
    await saveCookies(domain, cookies);

    console.log(`✓ 已保存 ${cookies.length} 个 Cookie`);
  } finally {
    await context.close();
    await browserManager.close();
  }
}

function isCookieLike(value: unknown): value is Cookie {
  if (!value || typeof value !== 'object') return false;
  const cookie = value as Partial<Cookie>;
  return (
    typeof cookie.name === 'string' &&
    typeof cookie.value === 'string' &&
    typeof cookie.domain === 'string' &&
    typeof cookie.path === 'string'
  );
}

function parseImportData(content: string): Record<string, Cookie[]> {
  const parsed = JSON.parse(content) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('导入文件格式错误，必须是 { domain: Cookie[] } 对象');
  }

  const result: Record<string, Cookie[]> = {};

  for (const [domain, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    const cookies = value.filter(isCookieLike);
    if (cookies.length > 0) {
      result[domain] = cookies;
    }
  }

  return result;
}

export function registerCookiesCommands(program: Command): void {
  const cookiesCmd = program
    .command('cookies')
    .description('Cookie 管理命令');

  // 添加 Cookie（交互式登录）
  cookiesCmd
    .command('add <domain>')
    .description('交互式登录并保存 Cookie')
    .option('--headless', '使用无头模式', false)
    .action(async (domain: string, options) => {
      const url = domain.startsWith('http') ? domain : `https://${domain}`;

      await runInteractiveCookieCapture(domain, url, options.headless);
    });

  // 添加 Cookie（兼容 create --domain --url 形式）
  cookiesCmd
    .command('create')
    .description('交互式登录并保存 Cookie（兼容命令）')
    .requiredOption('--domain <domain>', '域名，例如 youtube.com')
    .option('--url <url>', '登录页 URL，默认使用 https://<domain>')
    .option('--headless', '使用无头模式', false)
    .action(async (options: { domain: string; url?: string; headless: boolean }) => {
      const normalizedDomain = options.domain.replace(/^https?:\/\//, '');
      const url = options.url || `https://${normalizedDomain}`;

      await runInteractiveCookieCapture(normalizedDomain, url, options.headless);
    });

  // 列出 Cookie
  cookiesCmd
    .command('ls')
    .description('列出所有 Cookie')
    .option('--json', 'JSON 格式输出')
    .action((options) => {
      const cookies = listCookies();
      
      if (options.json) {
        console.log(JSON.stringify(cookies, null, 2));
        return;
      }
      
      if (cookies.length === 0) {
        console.log('没有保存的 Cookie');
        return;
      }
      
      console.log('\nDOMAIN              STATUS    EXPIRES_IN    ITEMS    LAST_UPDATED');
      console.log('────────────────────────────────────────────────────────────────');
      
      for (const cookie of cookies) {
        const expiresIn = cookie.expiresAt
          ? formatDuration(cookie.expiresAt - Date.now())
          : '-';
        const lastUpdated = formatDuration(Date.now() - cookie.updatedAt) + ' ago';
        
        console.log(
          `${cookie.domain.padEnd(19)} ${cookie.status.padEnd(9)} ${expiresIn.padEnd(13)} ${String(cookie.itemCount).padEnd(8)} ${lastUpdated}`
        );
      }
      console.log();
    });

  // 检查 Cookie（本地元数据检查）
  cookiesCmd
    .command('check <domain>')
    .description('本地元数据检查（不发网络请求）')
    .action((domain: string) => {
      const meta = getCookieMeta(domain);
      
      if (!meta) {
        console.log(`✗ 没有找到 ${domain} 的 Cookie`);
        return;
      }
      
      const cookies = loadCookies(domain);
      
      console.log(`\nDomain: ${meta.domain}`);
      console.log(`Status: ${meta.status}`);
      console.log(`Items: ${meta.itemCount}`);
      console.log(`Expires: ${meta.expiresAt ? new Date(meta.expiresAt).toLocaleString() : 'N/A'}`);
      console.log(`Updated: ${new Date(meta.updatedAt).toLocaleString()}`);
      
      if (cookies) {
        console.log('\nCookies (masked):');
        const masked = maskCookies(cookies);
        for (const cookie of masked.slice(0, 5)) {
          console.log(`  ${cookie.name}=${cookie.value}`);
        }
        if (masked.length > 5) {
          console.log(`  ... and ${masked.length - 5} more`);
        }
      }
    });

  // 验证 Cookie（在线验证）
  cookiesCmd
    .command('validate <domain>')
    .description('在线验证登录态（启动浏览器加载页面）')
    .option('--headless', '使用无头模式', false)
    .action(async (domain: string, options) => {
      const cookies = loadCookies(domain);
      
      if (!cookies) {
        console.log(`✗ 没有找到 ${domain} 的 Cookie`);
        return;
      }
      
      logger.info('Launching browser to validate cookies...');

      await browserManager.launch({
        headless: options.headless,
      });

      const pageWrapper = await createPage(browserManager);
      const { page, context } = pageWrapper;

      try {
        await context.addCookies(cookies);
        await pageWrapper.injectStealth();

        const url = domain.startsWith('http') ? domain : `https://${domain}`;
        await page.goto(url);

        console.log('\n浏览器已打开，Cookie 已加载。');
        console.log('请检查登录状态。');
        await readLineInput('按回车键关闭浏览器...');
      } finally {
        await context.close();
        await browserManager.close();
      }
    });

  // 删除 Cookie
  cookiesCmd
    .command('rm <domain>')
    .description('删除 Cookie')
    .option('--yes', '确认删除，不提示')
    .action(async (domain: string, options) => {
      if (!options.yes) {
        const answer = (await readLineInput(`确认删除 ${domain} 的 Cookie? [y/N] `)).toLowerCase();
        
        if (answer !== 'y' && answer !== 'yes') {
          console.log('取消删除');
          return;
        }
      }
      
      deleteCookies(domain);
      console.log(`✓ 已删除 ${domain} 的 Cookie`);
    });

  // 导出 Cookie
  cookiesCmd
    .command('export [domains...]')
    .description('导出 Cookie（不指定 domain 则全部导出）')
    .option('-o, --output <path>', '输出文件路径', './cookies-export.json')
    .action((domains: string[], options) => {
      const data = exportCookies(domains.length > 0 ? domains : undefined);
      
      writeFileSync(options.output, JSON.stringify(data, null, 2));
      console.log(`✓ 已导出到 ${options.output}`);
    });

  // 导入 Cookie
  cookiesCmd
    .command('import [domains...]')
    .description('导入 Cookie')
    .requiredOption('-i, --input <path>', '输入文件路径')
    .action((domains: string[], options) => {
      if (!existsSync(options.input)) {
        console.error(`✗ 文件不存在: ${options.input}`);
        return;
      }
      
      const content = readFileSync(options.input, 'utf-8');
      const data = parseImportData(content);
      
      if (domains.length > 0) {
        // 只导入指定域名
        for (const domain of domains) {
          if (data[domain]) {
            importCookiesFunc({ [domain]: data[domain] });
          }
        }
      } else {
        // 导入全部
        importCookiesFunc(data);
      }
      
      console.log(`✓ 已导入 Cookie`);
    });
}

// 格式化时长
function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const seconds = Math.floor(abs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export default registerCookiesCommands;
