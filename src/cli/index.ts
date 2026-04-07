#!/usr/bin/env node
/**
 * CLI 入口
 * 使用 Commander.js 构建命令行界面
 */

import { Command } from 'commander';
import { createLogger, setGlobalVerbosity, reconfigureLogger } from '../core/logger.js';
import config from '../core/config.js';
import { runBootstrapChecks } from '../core/bootstrap.js';
import { initDatabase, closeDatabase } from '../core/db.js';
import { pluginRegistry } from '../core/plugin-registry.js';
import { scheduler } from '../core/scheduler.js';

import { registerCookiesCommands } from './commands/cookies.js';
import { registerFetchCommand } from './commands/fetch.js';
import { registerServerCommands } from './commands/server.js';
import { registerPluginCommands } from './commands/plugin.js';

const logger = createLogger({ module: 'cli' });
let schedulerStarted = false;

function getCommandPath(command: Command): string[] {
  const path: string[] = [];
  let current: Command | null = command;

  while (current) {
    const name = current.name();
    if (name && name !== 'nexa') {
      path.unshift(name);
    }
    current = current.parent ?? null;
  }

  return path;
}

function shouldStartScheduler(commandPath: string[]): boolean {
  return commandPath[0] === 'server' && ['start', 'restart'].includes(commandPath[1] || '');
}

// 创建 CLI 程序
const program = new Command();

program
  .name('nexa')
  .description('Nexa Scraper - 基于 Playwright 的模块化网页抓取框架')
  .version(config.app.version, '--version', '显示版本号')
  .option('-v, -V, --verbose', '增加日志详细程度（可叠加：-vvv）', (_, prev) => prev + 1, 0)
  .option('-q, --quiet', '静默模式（仅输出最终结果）')
  .option('-j, --json', '强制 JSON 输出')
  .option('-c, --config <path>', '指定配置文件路径')
  .option('--no-color', '禁用 ANSI 颜色')
  .option('-d, --dry-run', '模拟运行')
  .hook('preAction', async (thisCommand) => {
    const opts = thisCommand.opts();
    const commandPath = getCommandPath(thisCommand);
    
    // 设置日志级别
    if (opts.quiet) {
      setGlobalVerbosity(0);
      process.env.LOG_LEVEL = 'error';
    } else {
      setGlobalVerbosity(opts.verbose);
    }
    reconfigureLogger();
    
    // 运行启动检查（除了某些命令）
    const skipCheckCommands = ['plugin', 'help'];
    const commandName = commandPath[0] || thisCommand.name();
    
    if (!skipCheckCommands.includes(commandName)) {
      const result = await runBootstrapChecks();
      if (!result.success) {
        process.exit(1);
      }
    }
    
    // 初始化数据库
    initDatabase();
    
    // 仅在长驻服务模式下启动调度器
    if (shouldStartScheduler(commandPath)) {
      scheduler.start();
      schedulerStarted = true;
    }
    
    // 加载插件
    await pluginRegistry.load();
  });

// 注册命令
registerCookiesCommands(program);
registerFetchCommand(program);
registerServerCommands(program);
registerPluginCommands(program);

// 处理未捕获的错误
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}`);
  console.error(error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
  process.exit(1);
});

// 运行 CLI
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } finally {
    if (schedulerStarted) {
      scheduler.stop();
      schedulerStarted = false;
    }
    closeDatabase();
  }
}

void main();
