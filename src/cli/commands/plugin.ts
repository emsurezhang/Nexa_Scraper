/**
 * Plugin 命令组
 * 管理插件的列出、安装、启用、禁用等
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join, basename } from 'path';
import { execSync } from 'child_process';
import { pluginRegistry } from '../../core/plugin-registry.js';
import { pluginOperations } from '../../core/db.js';
import type { NexaPlugin } from '../../core/plugin-contract.js';

const USER_PLUGINS_DIR = resolve(process.cwd(), 'user-plugins');

export function registerPluginCommands(program: Command): void {
  const pluginCmd = program
    .command('plugin')
    .description('插件管理命令');

  // 列出插件
  pluginCmd
    .command('ls')
    .description('列出已安装插件')
    .option('--enabled-only', '只显示已启用的插件')
    .option('--json', 'JSON 格式输出')
    .action(async (options) => {
      // 确保插件已加载
      if (pluginRegistry.size === 0) {
        await pluginRegistry.load();
      }

      const plugins = pluginRegistry.list();
      const dbRecords = pluginOperations.list();

      if (options.json) {
        console.log(JSON.stringify(plugins, null, 2));
        return;
      }

      if (plugins.length === 0) {
        console.log('没有已安装的插件');
        return;
      }

      console.log('\nNAME              VERSION   DOMAINS                 PRIORITY  STATUS');
      console.log('─────────────────────────────────────────────────────────────────────');

      for (const meta of plugins) {
        const record = dbRecords.find(r => r.name === meta.name);
        const status = record ? (record.enabled ? 'active' : 'disabled') : 'active';
        
        if (options.enabledOnly && status !== 'active') continue;

        const domains = meta.domains.join(', ').slice(0, 23).padEnd(23);
        console.log(
          `${meta.name.padEnd(17)} ${meta.version.padEnd(9)} ${domains} ${String(meta.priority).padEnd(9)} ${status}`
        );
      }
      console.log();
    });

  // 安装插件
  pluginCmd
    .command('install <source>')
    .description('安装插件')
    .option('--name <name>', '指定插件名称')
    .action(async (source: string, options) => {
      if (!existsSync(USER_PLUGINS_DIR)) {
        mkdirSync(USER_PLUGINS_DIR, { recursive: true });
      }

      let pluginPath: string;
      let pluginName: string;

      if (source.startsWith('npm:')) {
        // npm 包
        const pkgName = source.slice(4);
        pluginName = options.name || pkgName.replace('nexa-plugin-', '');
        pluginPath = join(USER_PLUGINS_DIR, pluginName);
        
        console.log(`Installing npm package: ${pkgName}...`);
        execSync(`npm install ${pkgName}`, { stdio: 'inherit' });
        
      } else if (source.startsWith('http')) {
        // Git 仓库
        pluginName = options.name || basename(source, '.git');
        pluginPath = join(USER_PLUGINS_DIR, pluginName);
        
        console.log(`Cloning repository: ${source}...`);
        
        if (existsSync(pluginPath)) {
          execSync(`git -C ${pluginPath} pull`, { stdio: 'inherit' });
        } else {
          execSync(`git clone ${source} ${pluginPath}`, { stdio: 'inherit' });
        }
        
      } else if (existsSync(source)) {
        // 本地目录
        pluginName = options.name || basename(source);
        pluginPath = join(USER_PLUGINS_DIR, pluginName);
        
        if (existsSync(pluginPath)) {
          console.log(`Plugin already exists at ${pluginPath}`);
          return;
        }
        
        // 创建符号链接或复制
        if (source.startsWith('/')) {
          execSync(`ln -s ${source} ${pluginPath}`);
        } else {
          execSync(`cp -r ${source} ${pluginPath}`);
        }
        
      } else {
        console.error(`✗ 无法识别的 source: ${source}`);
        console.log('支持的格式:');
        console.log('  - ./local-plugin/      本地目录');
        console.log('  - https://github.com/...  Git 仓库');
        console.log('  - npm:nexa-plugin-tiktok npm 包');
        return;
      }

      // 尝试加载插件
      try {
        await loadPluginFromPath(pluginPath);
        
        // 记录到数据库
        pluginOperations.save({
          name: pluginName,
          version: '1.0.0', // 应该从插件元数据获取
          source,
          enabled: 1,
          installed_at: Date.now(),
          meta: null,
        });

        console.log(`✓ 插件 ${pluginName} 安装成功`);
      } catch (error) {
        console.error(`✗ 安装失败: ${error}`);
      }
    });

  // 启用插件
  pluginCmd
    .command('enable <name>')
    .description('启用插件')
    .action((name: string) => {
      const record = pluginOperations.get(name);
      
      if (!record) {
        console.error(`✗ 插件不存在: ${name}`);
        return;
      }
      
      pluginOperations.setEnabled(name, true);
      console.log(`✓ 插件 ${name} 已启用`);
    });

  // 禁用插件
  pluginCmd
    .command('disable <name>')
    .description('禁用插件')
    .action((name: string) => {
      const record = pluginOperations.get(name);
      
      if (!record) {
        console.error(`✗ 插件不存在: ${name}`);
        return;
      }
      
      // 不能禁用通用插件
      if (name === 'general') {
        console.error('✗ 不能禁用通用插件');
        return;
      }
      
      pluginOperations.setEnabled(name, false);
      console.log(`✓ 插件 ${name} 已禁用`);
    });

  // 卸载插件
  pluginCmd
    .command('uninstall <name>')
    .description('卸载插件')
    .option('--yes', '确认卸载，不提示')
    .action(async (name: string, options) => {
      if (name === 'general') {
        console.error('✗ 不能卸载通用插件');
        return;
      }

      const record = pluginOperations.get(name);
      
      if (!record) {
        console.error(`✗ 插件不存在: ${name}`);
        return;
      }

      if (!options.yes) {
        process.stdout.write(`确认卸载插件 ${name}? [y/N] `);
        
        const answer = await new Promise<string>((resolve) => {
          process.stdin.once('data', (data) => {
            resolve(data.toString().trim().toLowerCase());
          });
        });
        
        if (answer !== 'y' && answer !== 'yes') {
          console.log('取消卸载');
          return;
        }
      }

      // 删除插件目录
      const pluginPath = join(USER_PLUGINS_DIR, name);
      if (existsSync(pluginPath)) {
        execSync(`rm -rf ${pluginPath}`);
      }

      // 从数据库删除
      pluginOperations.delete(name);
      
      // 从注册表卸载
      pluginRegistry.unregister(name);

      console.log(`✓ 插件 ${name} 已卸载`);
    });

  // 查看插件详情
  pluginCmd
    .command('info <name>')
    .description('查看插件详情')
    .option('--json', 'JSON 格式输出')
    .action((name: string, options) => {
      const plugin = pluginRegistry.get(name);
      const record = pluginOperations.get(name);
      
      if (!plugin && !record) {
        console.error(`✗ 插件不存在: ${name}`);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({
          meta: plugin?.meta,
          record,
        }, null, 2));
        return;
      }

      if (plugin) {
        console.log(`\nName:     ${plugin.meta.name}`);
        console.log(`Version:  ${plugin.meta.version}`);
        console.log(`Domains:  ${plugin.meta.domains.join(', ')}`);
        console.log(`Priority: ${plugin.meta.priority}`);
        if (plugin.meta.author) {
          console.log(`Author:   ${plugin.meta.author}`);
        }
        if (plugin.meta.requiresLogin) {
          console.log(`Requires: Login`);
        }
      }

      if (record) {
        console.log(`Status:   ${record.enabled ? 'enabled' : 'disabled'}`);
        console.log(`Source:   ${record.source || 'built-in'}`);
        console.log(`Installed: ${new Date(record.installed_at).toLocaleString()}`);
      }
    });

  // 测试插件
  pluginCmd
    .command('test <name>')
    .description('测试插件')
    .option('--url <url>', '使用真实 URL 测试')
    .option('--watch', '监视模式')
    .action(async (name: string, options) => {
      const plugin = pluginRegistry.get(name);
      
      if (!plugin) {
        console.error(`✗ 插件不存在: ${name}`);
        return;
      }

      if (options.url) {
        console.log(`Testing ${name} with URL: ${options.url}`);
        
        const matchPriority = plugin.matchUrl(options.url);
        console.log(`Match priority: ${matchPriority}`);
        
        // TODO: 实际抓取测试
      } else {
        // 运行插件的测试
        const testPath = resolve(process.cwd(), 'src/plugins/domain', name, 'tests/extractor.test.ts');
        
        if (existsSync(testPath)) {
          execSync(`npm test -- ${testPath}`, { stdio: 'inherit' });
        } else {
          console.log('没有找到测试文件');
        }
      }
    });

  // 初始化插件模板
  pluginCmd
    .command('init <name>')
    .description('创建新插件模板')
    .option('--template <type>', '模板类型: typescript|javascript', 'typescript')
    .action((name: string, options) => {
      const pluginDir = resolve(process.cwd(), 'src/plugins/domain', name);
      
      if (existsSync(pluginDir)) {
        console.error(`✗ 目录已存在: ${pluginDir}`);
        return;
      }

      mkdirSync(pluginDir, { recursive: true });
      mkdirSync(join(pluginDir, 'tests'), { recursive: true });

      const isTs = options.template === 'typescript';
      const ext = isTs ? 'ts' : 'js';

      // 创建主文件
      const indexContent = isTs
        ? generateTypeScriptTemplate(name)
        : generateJavaScriptTemplate(name);
      
      writeFileSync(join(pluginDir, `index.${ext}`), indexContent);

      // 创建类型定义文件（TS 模式）
      if (isTs) {
        writeFileSync(join(pluginDir, 'types.ts'), generateTypesTemplate(name));
      }

      // 创建测试文件
      writeFileSync(
        join(pluginDir, 'tests', `extractor.test.${ext}`),
        generateTestTemplate(name, isTs)
      );

      // 创建 README
      writeFileSync(
        join(pluginDir, 'README.md'),
        generateReadmeTemplate(name)
      );

      console.log(`✓ 插件模板已创建: ${pluginDir}`);
      console.log(`\n接下来:`);
      console.log(`  1. 编辑 ${pluginDir}/index.${ext}`);
      console.log(`  2. 实现 url-matcher 和 extractor 逻辑`);
      console.log(`  3. 运行测试: nexa plugin test ${name}`);
    });
}

// 从路径加载插件
async function loadPluginFromPath(path: string): Promise<void> {
  const indexPath = join(path, 'index.js');
  
  if (!existsSync(indexPath)) {
    throw new Error(`No index.js found in ${path}`);
  }

  const module = await import(indexPath);
  const PluginClass = module.default || Object.values(module)[0];
  
  if (!PluginClass || typeof PluginClass !== 'function') {
    throw new Error('No valid plugin class found');
  }

  const plugin: NexaPlugin = new PluginClass();
  pluginRegistry.register(plugin);
}

// 生成 TypeScript 模板
function generateTypeScriptTemplate(name: string): string {
  return `import type { NexaPlugin, PluginMeta, ListItem, SingleItem, Page } from '../../core/plugin-contract.js';

export class ${toPascalCase(name)}Plugin implements NexaPlugin {
  meta: PluginMeta = {
    name: '${name}',
    version: '1.0.0',
    domains: ['example.com'],
    priority: 5,
  };

  matchUrl(url: string): number | null {
    // 返回 0-9 的优先级，null 表示不匹配
    if (url.includes('example.com')) {
      return 5;
    }
    return null;
  }

  pageType(url: string, html: string): 'list' | 'single' | 'unknown' {
    if (url.includes('/list') || url.includes('/category')) {
      return 'list';
    }
    return 'single';
  }

  async waitForContent(page: Page): Promise<void> {
    // 等待关键元素出现
    await page.waitForLoadState('networkidle');
    // await page.waitForSelector('.content', { timeout: 10000 });
  }

  async extractList(html: string, url: string): Promise<ListItem[]> {
    // 实现列表提取逻辑
    const items: ListItem[] = [];
    
    // TODO: 使用 cheerio 或其他工具解析 HTML
    
    return items;
  }

  async extractSingle(html: string, url: string): Promise<SingleItem> {
    // 实现详情提取逻辑
    return {
      id: 'unique-id',
      url,
      title: 'Title',
      content: 'Content',
    };
  }
}

export default ${toPascalCase(name)}Plugin;
`;
}

// 生成 JavaScript 模板
function generateJavaScriptTemplate(name: string): string {
  return `/** @typedef {import('../../core/plugin-contract.js').NexaPlugin} NexaPlugin */
/** @typedef {import('../../core/plugin-contract.js').PluginMeta} PluginMeta */
/** @typedef {import('../../core/plugin-contract.js').ListItem} ListItem */
/** @typedef {import('../../core/plugin-contract.js').SingleItem} SingleItem */

export class ${toPascalCase(name)}Plugin {
  meta = {
    name: '${name}',
    version: '1.0.0',
    domains: ['example.com'],
    priority: 5,
  };

  matchUrl(url) {
    if (url.includes('example.com')) {
      return 5;
    }
    return null;
  }

  pageType(url, html) {
    if (url.includes('/list') || url.includes('/category')) {
      return 'list';
    }
    return 'single';
  }

  async waitForContent(page) {
    await page.waitForLoadState('networkidle');
  }

  async extractList(html, url) {
    const items = [];
    // TODO: 实现提取逻辑
    return items;
  }

  async extractSingle(html, url) {
    return {
      id: 'unique-id',
      url,
      title: 'Title',
      content: 'Content',
    };
  }
}

export default ${toPascalCase(name)}Plugin;
`;
}

// 生成类型模板
function generateTypesTemplate(name: string): string {
  return `// ${name} 插件的类型定义

export interface ${toPascalCase(name)}Item {
  id: string;
  title: string;
  url: string;
  // 添加更多字段...
}

export interface ${toPascalCase(name)}Config {
  // 插件配置项...
}
`;
}

// 生成测试模板
function generateTestTemplate(name: string, isTs: boolean): string {
  const ext = isTs ? '' : '.js';
  return `import { describe, it, expect } from 'vitest';
import { ${toPascalCase(name)}Plugin } from '../index${ext}';

describe('${name} plugin', () => {
  const plugin = new ${toPascalCase(name)}Plugin();

  it('should have correct meta', () => {
    expect(plugin.meta.name).toBe('${name}');
    expect(plugin.meta.version).toBe('1.0.0');
  });

  it('should match example.com URLs', () => {
    expect(plugin.matchUrl('https://example.com/page')).toBe(5);
    expect(plugin.matchUrl('https://other.com/page')).toBeNull();
  });

  it('should extract list items', async () => {
    const html = \`
      <html>
        <body>
          <div class="item">Item 1</div>
          <div class="item">Item 2</div>
        </body>
      </html>
    \`;
    
    const items = await plugin.extractList(html, 'https://example.com/list');
    expect(Array.isArray(items)).toBe(true);
  });
});
`;
}

// 生成 README 模板
function generateReadmeTemplate(name: string): string {
  return `# ${name} Plugin

Nexa Scraper 插件

## 功能

- URL 匹配
- 列表页提取
- 详情页提取

## 使用

\`\`\`bash
nexa fetch "https://example.com/page" --plugin ${name}
\`\`\`

## 开发

\`\`\`bash
# 运行测试
nexa plugin test ${name}

# 使用真实 URL 测试
nexa plugin test ${name} --url "https://example.com/page"
\`\`\`
`;
}

// 转换为 PascalCase
function toPascalCase(str: string): string {
  return str
    .replace(/[-_](.)/g, (_, char) => char.toUpperCase())
    .replace(/^(.)/, (_, char) => char.toUpperCase());
}

export default registerPluginCommands;
