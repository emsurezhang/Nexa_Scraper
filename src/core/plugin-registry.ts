/**
 * 插件注册与管理模块
 * 负责插件的加载、注册和路由
 */

import { readdirSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';
import type { NexaPlugin, PluginMeta } from './plugin-contract.js';

const logger = createLogger({ module: 'plugin-registry' });

// 插件注册表
export class PluginRegistry {
  private plugins = new Map<string, NexaPlugin>();
  private domainMappings = new Map<string, NexaPlugin[]>();

  private getProjectRoot(): string {
    // 获取项目根目录（package.json 所在目录）
    // __dirname for CommonJS, fileURLToPath(import.meta.url) for ESM
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // src/core/plugin-registry.ts → 项目根目录
    return resolve(__dirname, '../../');
  }

  private isDistRuntime(): boolean {
    // import.meta.url is a file URL; compiled entrypoints live under /dist/ while tsx/dev runs from /src/.
    return import.meta.url.includes('/dist/');
  }

  private getDomainPluginDirs(): string[] {
    // 始终以项目根目录为基准，保证任意目录运行都能找到插件
    const projectRoot = this.getProjectRoot();
    const candidates = this.isDistRuntime()
      ? [resolve(projectRoot, 'dist/plugins/domain')]
      : [resolve(projectRoot, 'src/plugins/domain')];
    return candidates.filter((dir) => existsSync(dir));
  }

  private resolveDomainPluginEntry(pluginDir: string): string | null {
    const jsEntry = join(pluginDir, 'index.js');
    if (existsSync(jsEntry)) {
      return jsEntry;
    }

    const tsEntry = join(pluginDir, 'index.ts');
    if (existsSync(tsEntry)) {
      return tsEntry;
    }

    return null;
  }

  // 加载所有插件
  async load(): Promise<void> {
    logger.info('Loading plugins...');
    
    // 加载内置通用插件
    await this.loadGeneralPlugin();
    
    // 加载 domain 插件
    await this.loadDomainPlugins();
    
    logger.info(`Loaded ${this.plugins.size} plugins`);
  }

  // 加载通用插件
  private async loadGeneralPlugin(): Promise<void> {
    try {
      const { GeneralHtmlPlugin } = await import('../plugins/general/index.js');
      const plugin = new GeneralHtmlPlugin();
      this.register(plugin);
      logger.debug(`Loaded general plugin: ${plugin.meta.name}`);
    } catch (error) {
      logger.error(`Failed to load general plugin: ${error}`);
    }
  }

  // 加载 domain 插件
  private async loadDomainPlugins(): Promise<void> {
    const domainDirs = this.getDomainPluginDirs();

    if (domainDirs.length === 0) {
      logger.debug('No domain plugins directory found');
      return;
    }

    for (const domainsDir of domainDirs) {
      const entries = readdirSync(domainsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          await this.loadDomainPlugin(entry.name, join(domainsDir, entry.name));
        }
      }
    }
  }

  // 加载单个 domain 插件
  private async loadDomainPlugin(name: string, path: string): Promise<void> {
    try {
      const indexPath = this.resolveDomainPluginEntry(path);

      if (!indexPath) {
        logger.warn(`No index file found for plugin: ${name}`);
        return;
      }

      // 动态导入插件
      const module = await import(indexPath);
      const PluginClass = module.default || module[name] || Object.values(module)[0];
      
      if (!PluginClass || typeof PluginClass !== 'function') {
        logger.warn(`No valid plugin class found in: ${name}`);
        return;
      }

      const plugin: NexaPlugin = new PluginClass();
      this.register(plugin);
      logger.debug(`Loaded domain plugin: ${plugin.meta.name} v${plugin.meta.version}`);
      
    } catch (error) {
      logger.error(`Failed to load domain plugin ${name}: ${error}`);
    }
  }

  // 注册插件
  register(plugin: NexaPlugin): void {
    const { name } = plugin.meta;
    
    if (this.plugins.has(name)) {
      logger.warn(`Plugin ${name} already registered, overwriting`);
    }
    
    this.plugins.set(name, plugin);
    
    // 建立域名映射
    for (const domain of plugin.meta.domains) {
      if (!this.domainMappings.has(domain)) {
        this.domainMappings.set(domain, []);
      }
      this.domainMappings.get(domain)!.push(plugin);
    }
    
    // 按优先级排序
    for (const [, plugins] of this.domainMappings) {
      plugins.sort((a, b) => a.meta.priority - b.meta.priority);
    }
  }

  // 根据 URL 解析插件
  resolve(url: string): NexaPlugin {
    // 1. 尝试所有插件的 matchUrl 方法
    let bestMatch: NexaPlugin | null = null;
    let bestPriority: number | null = null;
    
    for (const plugin of this.plugins.values()) {
      const priority = plugin.matchUrl(url);
      
      if (priority !== null) {
        if (bestPriority === null || priority < bestPriority) {
          bestMatch = plugin;
          bestPriority = priority;
        }
      }
    }
    
    if (bestMatch) {
      logger.debug(`Resolved plugin for ${url}: ${bestMatch.meta.name} (priority: ${bestPriority})`);
      return bestMatch;
    }
    
    // 2. 如果没有匹配，返回通用插件
    const generalPlugin = this.plugins.get('general');
    if (generalPlugin) {
      logger.debug(`Using general plugin for: ${url}`);
      return generalPlugin;
    }
    
    // 3. 如果通用插件也没有，抛出错误
    throw new Error('No plugin available to handle this URL');
  }

  // 获取插件
  get(name: string): NexaPlugin | undefined {
    return this.plugins.get(name);
  }

  // 列出所有插件
  list(): PluginMeta[] {
    return Array.from(this.plugins.values()).map(p => p.meta);
  }

  // 列出特定域名的插件
  listForDomain(domain: string): PluginMeta[] {
    const plugins = this.domainMappings.get(domain);
    return (plugins || []).map(p => p.meta);
  }

  // 卸载插件
  unregister(name: string): boolean {
    const plugin = this.plugins.get(name);
    
    if (!plugin) {
      return false;
    }
    
    // 从域名映射中移除
    for (const domain of plugin.meta.domains) {
      const plugins = this.domainMappings.get(domain);
      if (plugins) {
        const index = plugins.indexOf(plugin);
        if (index > -1) {
          plugins.splice(index, 1);
        }
      }
    }
    
    this.plugins.delete(name);
    logger.debug(`Unregistered plugin: ${name}`);
    
    return true;
  }

  // 获取插件数量
  get size(): number {
    return this.plugins.size;
  }
}

// 导出单例
export const pluginRegistry = new PluginRegistry();

export default pluginRegistry;
