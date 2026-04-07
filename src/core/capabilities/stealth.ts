/**
 * Stealth 注入模块
 * 通过 page.addInitScript 手动注入反检测脚本
 */

import type { Page } from 'playwright';
import { createLogger } from '../logger.js';

const logger = createLogger({ module: 'stealth' });

export interface StealthOptions {
  injectCanvas?: boolean;
  injectWebGL?: boolean;
}

// Stealth 脚本集合
const STEALTH_SCRIPTS = {
  // 移除 webdriver 标识
  webdriver: `
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  `,

  // 修复 chrome 对象
  chromeRuntime: `
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
  `,

  // 修复 permissions API
  permissions: `
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => {
        if (parameters && parameters.name === 'notifications') {
          return Promise.resolve({
            state: window.Notification ? window.Notification.permission : 'default',
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false
          });
        }
        return originalQuery.call(window.navigator.permissions, parameters);
      };
    }
  `,

  // 修复 languages
  languages: `
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en']
    });
  `,

  // 修复 plugins
  plugins: `
    const fakePlugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ];

    Object.defineProperty(navigator, 'plugins', {
      get: () => fakePlugins
    });

    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => [
        { type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: fakePlugins[1] },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: fakePlugins[0] }
      ]
    });
  `,

  // 降低 playwright 典型标记
  playwrightArtifacts: `
    Object.defineProperty(window, '__playwright__binding__', {
      get: () => undefined,
      configurable: false
    });
    Object.defineProperty(window, '__pwInitScripts', {
      get: () => undefined,
      configurable: false
    });
  `,

  // Canvas 指纹噪声
  canvas: `
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
      const imageData = originalGetImageData.call(this, x, y, w, h);
      const data = imageData.data;
      
      // 使用确定性微噪声，避免每次指纹波动过大
      for (let i = 0; i < data.length; i += 4) {
        const noise = ((i % 8) - 3.5) * 0.1;
        data[i] = Math.max(0, Math.min(255, data[i] + noise));
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
      }
      
      return imageData;
    };
  `,

  // WebGL 指纹混淆
  webgl: `
    const getParameterProxyHandler = {
      apply: function(target, thisArg, args) {
        const param = args[0];
        
        // 混淆一些常见的 WebGL 参数
        if (param === 37445) {
          return 'Intel Inc.';
        }
        if (param === 37446) {
          return 'Intel Iris OpenGL Engine';
        }
        
        return target.apply(thisArg, args);
      }
    };
    
    const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = new Proxy(originalGetParameter, getParameterProxyHandler);
  `,

  // 修复 notification 权限
  notification: `
    if (window.Notification && window.Notification.permission === 'denied') {
      Object.defineProperty(window.Notification, 'permission', {
        get: () => 'default'
      });
    }
  `,

  // 修复 iframe 的 contentWindow
  iframe: `
    const originalCreateElement = document.createElement;
    document.createElement = function(...args) {
      const element = originalCreateElement.call(this, ...args);
      
      if (args[0] === 'iframe') {
        try {
          Object.defineProperty(element, 'contentWindow', {
            get: () => window
          });
        } catch (e) {}
      }
      
      return element;
    };
  `,
};

// 注入所有 stealth 脚本
export async function injectStealth(page: Page, options: StealthOptions = {}): Promise<void> {
  const scripts: string[] = [];

  // 基础脚本（总是注入）
  scripts.push(STEALTH_SCRIPTS.webdriver);
  scripts.push(STEALTH_SCRIPTS.chromeRuntime);
  scripts.push(STEALTH_SCRIPTS.permissions);
  scripts.push(STEALTH_SCRIPTS.languages);
  scripts.push(STEALTH_SCRIPTS.plugins);
  scripts.push(STEALTH_SCRIPTS.playwrightArtifacts);
  scripts.push(STEALTH_SCRIPTS.notification);
  scripts.push(STEALTH_SCRIPTS.iframe);

  // 可选脚本
  if (options.injectCanvas !== false) {
    scripts.push(STEALTH_SCRIPTS.canvas);
  }
  
  if (options.injectWebGL !== false) {
    scripts.push(STEALTH_SCRIPTS.webgl);
  }

  // 批量注入脚本
  for (const script of scripts) {
    try {
      await page.addInitScript(script);
    } catch (error) {
      logger.warn(`Failed to inject stealth script: ${error}`);
    }
  }

  logger.debug('Stealth scripts injected successfully');
}

export default injectStealth;
