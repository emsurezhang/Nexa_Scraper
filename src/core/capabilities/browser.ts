/**
 * Playwright 浏览器操作封装
 * 提供统一的浏览器和页面管理功能
 */

import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page, type LaunchOptions } from 'playwright';
import { existsSync } from 'fs';
import config from '../config.js';
import { createLogger } from '../logger.js';
import { injectStealth } from './stealth.js';

const logger = createLogger({ module: 'browser' });

// 支持的浏览器类型
export type BrowserType = 'chromium' | 'firefox' | 'webkit';

export interface BrowserOptions {
  browserType?: BrowserType;
  headless?: boolean;
  proxy?: string;
  userDataDir?: string;
  extraArgs?: string[];
}

export interface ContextOptions {
  locale?: string;
  timezone?: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
  proxy?: { server: string; username?: string; password?: string };
  storageState?: string;
}

// 浏览器管理器类
export class BrowserManager {
  private browser: Browser | null = null;
  private browserType: BrowserType = 'chromium';

  private async launchChromiumWithFallback(launchOptions: LaunchOptions, headless: boolean): Promise<Browser> {
    const preferSystemChannel = process.env.NEXA_BROWSER_CHANNEL !== 'chromium';

    if (preferSystemChannel) {
      const channel = (process.env.NEXA_BROWSER_CHANNEL || 'chrome') as 'chrome' | 'chrome-beta' | 'chrome-dev' | 'chrome-canary' | 'msedge' | 'msedge-beta' | 'msedge-dev' | 'msedge-canary';

      try {
        logger.info(`Trying Chromium channel: ${channel}`);
        return await chromium.launch({
          ...launchOptions,
          channel,
        });
      } catch (error) {
        logger.warn(`Failed to launch channel ${channel}, fallback to bundled chromium: ${error}`);
      }
    }

    return chromium.launch({
      ...launchOptions,
      headless,
    });
  }

  async launch(options: BrowserOptions = {}): Promise<Browser> {
    if (this.browser) {
      return this.browser;
    }

    this.browserType = options.browserType || 'chromium';
    const headless = options.headless ?? config.browser.headless;
    
    logger.info(`Launching ${this.browserType} browser (headless: ${headless})`);

    const launchOptions: LaunchOptions = {
      headless,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        ...(options.extraArgs || []),
      ],
    };

    if (options.proxy) {
      launchOptions.proxy = { server: options.proxy };
    }

    switch (this.browserType) {
      case 'chromium':
        this.browser = await this.launchChromiumWithFallback(launchOptions, headless);
        break;
      case 'firefox':
        this.browser = await firefox.launch(launchOptions);
        break;
      case 'webkit':
        this.browser = await webkit.launch(launchOptions);
        break;
      default:
        throw new Error(`Unsupported browser type: ${this.browserType}`);
    }

    logger.info(`Browser launched: ${this.browser.version()}`);
    
    return this.browser;
  }

  async createContext(options: ContextOptions = {}): Promise<BrowserContext> {
    const browser = await this.launch();

    const defaultUserAgent = this.browserType === 'chromium'
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
      : undefined;
    
    const contextOptions: Parameters<typeof browser.newContext>[0] = {
      locale: options.locale || config.browser.locale,
      timezoneId: options.timezone || config.browser.timezone,
      viewport: options.viewport || {
        width: config.browser.viewportWidth,
        height: config.browser.viewportHeight,
      },
      userAgent: options.userAgent || config.browser.userAgent || defaultUserAgent,
      extraHTTPHeaders: {
        'Accept-Language': `${options.locale || config.browser.locale},en;q=0.9`,
      },
    };

    if (options.proxy) {
      contextOptions.proxy = options.proxy;
    }

    if (options.storageState && existsSync(options.storageState)) {
      contextOptions.storageState = options.storageState;
    }

    const context = await browser.newContext(contextOptions);
    logger.debug(`New browser context created`);
    
    return context;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info('Browser closed');
    }
  }

  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }
}

// 页面封装类
export class PageWrapper {
  constructor(
    public readonly page: Page,
    public readonly context: BrowserContext
  ) {}

  async goto(url: string, timeout?: number): Promise<void> {
    const gotoTimeout = timeout || config.fetch.defaultTimeout;
    
    logger.debug(`Navigating to: ${url}`);
    
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: gotoTimeout,
    });
  }

  async injectStealth(): Promise<void> {
    if (config.browser.stealth.enabled) {
      await injectStealth(this.page, {
        injectCanvas: config.browser.stealth.injectCanvas,
        injectWebGL: config.browser.stealth.injectWebGL,
      });
      logger.debug('Stealth scripts injected');
    }
  }

  async screenshot(path: string, fullPage = false): Promise<void> {
    await this.page.screenshot({ path, fullPage });
    logger.debug(`Screenshot saved: ${path}`);
  }

  async getHtml(): Promise<string> {
    return this.page.content();
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}

// 创建页面包装器
export async function createPage(
  browserManager: BrowserManager,
  options: ContextOptions = {}
): Promise<PageWrapper> {
  const context = await browserManager.createContext(options);
  const page = await context.newPage();
  return new PageWrapper(page, context);
}

// 导出单例（用于 CLI 模式）
export const browserManager = new BrowserManager();

export default browserManager;
