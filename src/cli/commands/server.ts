/**
 * Server 命令组
 * 管理 HTTP API Server 的启动、停止、状态等
 */

import { Command } from 'commander';
import { spawn, execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import config from '../../core/config.js';

const PID_FILE = resolve(process.cwd(), 'tmp/server.pid');
const LOG_FILE = resolve(process.cwd(), config.storage.logsDir, 'server.log');

export function registerServerCommands(program: Command): void {
  const serverCmd = program
    .command('server')
    .description('HTTP API Server 管理');

  // 启动服务器
  serverCmd
    .command('start')
    .description('启动 HTTP API Server')
    .option('-p, --port <number>', '端口号', String(config.server.port))
    .option('-h, --host <address>', '主机地址', config.server.host)
    .option('--daemon', '后台运行')
    .option('--log <path>', '日志文件路径', LOG_FILE)
    .action(async (options) => {
      // 检查是否已在运行
      if (isServerRunning()) {
        console.log('✗ Server 已经在运行');
        return;
      }

      const { startServer } = await import('../../server/index.js');

      if (options.daemon) {
        // 后台模式
        console.log('正在后台启动 Server...');
        
        const child = spawn('node', [
          resolve(process.cwd(), 'dist/cli/index.js'),
          'server',
          'start',
          '--port', options.port,
          '--host', options.host,
        ], {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        });

        child.unref();
        
        // 等待确认启动
        await sleep(2000);
        
        if (isServerRunning()) {
          console.log('✓ Server 已后台启动');
          showStatus();
        } else {
          console.log('✗ Server 启动失败');
        }
      } else {
        // 前台模式
        console.log(`正在启动 Server on ${options.host}:${options.port}...`);
        
        // 保存 PID
        writeFileSync(PID_FILE, process.pid.toString());
        
        await startServer({
          port: parseInt(options.port),
          host: options.host,
        });
      }
    });

  // 停止服务器
  serverCmd
    .command('stop')
    .description('停止 HTTP API Server')
    .option('--force', '强制停止')
    .action((options) => {
      if (!isServerRunning()) {
        console.log('✗ Server 未在运行');
        return;
      }

      const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));
      
      try {
        if (options.force) {
          process.kill(pid, 'SIGKILL');
        } else {
          process.kill(pid, 'SIGTERM');
        }
        
        // 等待进程结束
        let attempts = 0;
        while (isProcessRunning(pid) && attempts < 10) {
          sleep(500);
          attempts++;
        }

        if (!isProcessRunning(pid)) {
          unlinkSync(PID_FILE);
          console.log('✓ Server 已停止');
        } else {
          console.log('✗ Server 停止超时，请使用 --force 强制停止');
        }
      } catch (error) {
        console.log(`✗ 停止失败: ${error}`);
      }
    });

  // 重启服务器
  serverCmd
    .command('restart')
    .description('重启 HTTP API Server')
    .option('--graceful', '优雅重启')
    .action(async () => {
      if (isServerRunning()) {
        const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));
        
        try {
          process.kill(pid, 'SIGTERM');
          await sleep(2000);
        } catch {}
      }

      // 重新启动
      const { startServer } = await import('../../server/index.js');
      
      writeFileSync(PID_FILE, process.pid.toString());
      
      await startServer({
        port: config.server.port,
        host: config.server.host,
      });
    });

  // 查看状态
  serverCmd
    .command('status')
    .description('查看 Server 状态')
    .action(() => {
      showStatus();
    });

  // 查看日志
  serverCmd
    .command('logs')
    .description('查看 Server 日志')
    .option('-f, --follow', '持续跟踪日志')
    .option('--level <level>', '过滤日志级别')
    .option('--since <duration>', '显示最近 duration 的日志', '1h')
    .action((options) => {
      if (!existsSync(LOG_FILE)) {
        console.log('暂无日志文件');
        return;
      }

      const since = parseDuration(options.since);
      const cutoff = Date.now() - since;

      if (options.follow) {
        // 使用 tail -f
        const tail = spawn('tail', ['-f', LOG_FILE], {
          stdio: 'inherit',
        });
        
        process.on('SIGINT', () => {
          tail.kill();
          process.exit(0);
        });
      } else {
        // 读取并过滤日志
        const content = readFileSync(LOG_FILE, 'utf-8');
        const lines = content.split('\n').filter(line => {
          if (!line.trim()) return false;
          
          try {
            const log = JSON.parse(line);
            
            // 级别过滤
            if (options.level && log.level !== options.level) {
              return false;
            }
            
            // 时间过滤
            if (log.time && log.time < cutoff) {
              return false;
            }
            
            return true;
          } catch {
            return true;
          }
        });

        console.log(lines.join('\n'));
      }
    });
}

// 检查 Server 是否运行
function isServerRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));
    return isProcessRunning(pid);
  } catch {
    return false;
  }
}

// 检查进程是否运行
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 显示状态
function showStatus(): void {
  if (!isServerRunning()) {
    console.log('Status: stopped');
    return;
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));
  
  console.log('Status:   running');
  console.log(`PID:      ${pid}`);
  
  try {
    // 尝试获取内存使用
    const stats = execSync(`ps -p ${pid} -o rss=`, { encoding: 'utf-8' });
    const memoryMB = Math.round(parseInt(stats.trim()) / 1024);
    console.log(`Memory:   ${memoryMB} MB`);
  } catch {
    console.log('Memory:   unknown');
  }
  
  console.log(`Endpoint: http://${config.server.host}:${config.server.port}`);
  
  // 尝试获取健康检查信息
  try {
    const health = execSync(
      `curl -s http://${config.server.host}:${config.server.port}/health`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const data = JSON.parse(health);
    
    if (data.uptime) {
      console.log(`Uptime:   ${formatDuration(data.uptime * 1000)}`);
    }
    if (data.browserPool) {
      console.log(`Browsers: ${data.browserPool.active}/${data.browserPool.max} active`);
    }
    if (data.queue) {
      console.log(`Queue:    ${data.queue.pending} pending`);
    }
  } catch {
    // 忽略健康检查错误
  }
}

// 解析时长字符串
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) return 3600000; // 默认 1 小时

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return value * 60 * 60 * 1000;
  }
}

// 格式化时长
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default registerServerCommands;
