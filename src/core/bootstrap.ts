/**
 * 启动检查模块
 * 在应用启动时检查必要的依赖是否可用
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from './logger.js';

const logger = createLogger({ module: 'bootstrap' });

export interface BootstrapResult {
  success: boolean;
  checks: {
    name: string;
    status: 'ok' | 'warn' | 'error';
    message: string;
  }[];
}

// 检查 Playwright 是否安装
async function checkPlaywright(): Promise<{ status: 'ok' | 'warn' | 'error'; message: string }> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const version = browser.version();
    await browser.close();
    
    return {
      status: 'ok',
      message: `Chromium ${version} is available`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    
    if (msg.includes('Executable doesn\'t exist')) {
      return {
        status: 'error',
        message: 'Playwright browsers not installed. Run: npx playwright install chromium',
      };
    }
    
    return {
      status: 'error',
      message: `Playwright check failed: ${msg}`,
    };
  }
}

// 检查 ffmpeg 是否可用
function checkFfmpeg(): { status: 'ok' | 'warn' | 'error'; message: string } {
  try {
    const output = execSync('ffmpeg -version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    const version = output.split('\n')[0];
    
    return {
      status: 'ok',
      message: version,
    };
  } catch {
    return {
      status: 'warn',
      message: 'ffmpeg not found in PATH. Media processing features will be disabled.',
    };
  }
}

// 检查 Whisper 是否可用
function checkWhisper(): { status: 'ok' | 'warn' | 'error'; message: string } {
  // 检查 whisper.cpp 命令
  try {
    const output = execSync('whisper-cli --help', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    
    return {
      status: 'ok',
      message: `whisper.cpp is available (${output.split('\n')[0].trim() || 'whisper-cli'})`,
    };
  } catch {
    return {
      status: 'warn',
      message: 'whisper.cpp (whisper-cli) not found. Install with: brew install whisper-cpp',
    };
  }
}

// 检查目录结构
function checkDirectories(): { status: 'ok' | 'warn' | 'error'; message: string } {
  const requiredDirs = ['config', 'src', 'data', 'logs', 'tmp'];
  const missingDirs: string[] = [];
  
  for (const dir of requiredDirs) {
    const path = resolve(process.cwd(), dir);
    if (!existsSync(path)) {
      missingDirs.push(dir);
    }
  }
  
  if (missingDirs.length > 0) {
    return {
      status: 'warn',
      message: `Missing directories: ${missingDirs.join(', ')}`,
    };
  }
  
  return {
    status: 'ok',
    message: 'All required directories exist',
  };
}

// 运行所有检查
export async function runBootstrapChecks(): Promise<BootstrapResult> {
  logger.info('Running bootstrap checks...');
  
  const checks: BootstrapResult['checks'] = [];
  
  // 检查目录结构
  const dirCheck = checkDirectories();
  checks.push({ name: 'Directories', ...dirCheck });
  
  // 检查 Playwright
  const pwCheck = await checkPlaywright();
  checks.push({ name: 'Playwright', ...pwCheck });
  
  // 检查 ffmpeg
  const ffmpegCheck = checkFfmpeg();
  checks.push({ name: 'ffmpeg', ...ffmpegCheck });
  
  // 检查 Whisper
  const whisperCheck = checkWhisper();
  checks.push({ name: 'Whisper', ...whisperCheck });
  
  // 判断整体状态
  const hasError = checks.some(c => c.status === 'error');
  
  const result: BootstrapResult = {
    success: !hasError,
    checks,
  };
  
  // 输出检查结果
  for (const check of checks) {
    const icon = check.status === 'ok' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
    const level = check.status === 'ok' ? 'info' : check.status === 'warn' ? 'warn' : 'error';
    logger[level](`[${icon}] ${check.name}: ${check.message}`);
  }
  
  if (result.success) {
    logger.info('Bootstrap checks completed successfully');
  } else {
    logger.error('Bootstrap checks failed. Please fix the errors above.');
  }
  
  return result;
}

export default runBootstrapChecks;
