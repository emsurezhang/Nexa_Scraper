/**
 * 定时任务调度器
 * 负责定期清理临时文件和调试产物
 */

import { readdirSync, statSync, unlinkSync, rmdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import config from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger({ module: 'scheduler' });

export class Scheduler {
  private timers: NodeJS.Timeout[] = [];

  start(): void {
    if (this.timers.length > 0) {
      logger.debug('Scheduler already started, skipping');
      return;
    }

    logger.info('Starting scheduler...');
    
    // 每小时清理临时文件
    const tmpTimer = setInterval(() => {
      this.cleanupTmpFiles();
    }, 60 * 60 * 1000);
    tmpTimer.unref();
    
    // 每天清理调试产物
    const debugTimer = setInterval(() => {
      this.cleanupDebugFiles();
    }, 24 * 60 * 60 * 1000);
    debugTimer.unref();
    
    // 立即执行一次清理
    this.cleanupTmpFiles();
    this.cleanupDebugFiles();
    
    this.timers.push(tmpTimer, debugTimer);
    
    logger.info('Scheduler started');
  }

  stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    logger.info('Scheduler stopped');
  }

  // 清理临时文件
  private cleanupTmpFiles(): void {
    const tmpDir = resolve(process.cwd(), config.storage.tmpDir);
    const maxAgeMs = config.storage.tmpTtlHours * 60 * 60 * 1000;
    
    if (!existsSync(tmpDir)) return;
    
    logger.debug('Cleaning up temporary files...');
    
    try {
      const removed = this.cleanupDirectory(tmpDir, maxAgeMs);
      if (removed > 0) {
        logger.info(`Cleaned up ${removed} temporary files`);
      }
    } catch (error) {
      logger.error(`Failed to cleanup tmp files: ${error}`);
    }
  }

  // 清理调试产物
  private cleanupDebugFiles(): void {
    const debugDir = resolve(process.cwd(), config.storage.debugDir);
    const maxAgeMs = config.storage.debugTtlDays * 24 * 60 * 60 * 1000;
    
    if (!existsSync(debugDir)) return;
    
    logger.debug('Cleaning up debug files...');
    
    try {
      const removed = this.cleanupDirectory(debugDir, maxAgeMs);
      if (removed > 0) {
        logger.info(`Cleaned up ${removed} debug files`);
      }
    } catch (error) {
      logger.error(`Failed to cleanup debug files: ${error}`);
    }
  }

  // 递归清理目录中的过期文件
  private cleanupDirectory(dir: string, maxAgeMs: number): number {
    let removed = 0;
    const now = Date.now();
    
    try {
      const entries = readdirSync(dir);
      
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        
        try {
          const stats = statSync(fullPath);
          const age = now - stats.mtime.getTime();
          
          if (stats.isDirectory()) {
            // 递归清理子目录
            removed += this.cleanupDirectory(fullPath, maxAgeMs);
            
            // 如果目录为空，删除目录
            try {
              const remaining = readdirSync(fullPath);
              if (remaining.length === 0) {
                rmdirSync(fullPath);
                removed++;
              }
            } catch {}
          } else if (age > maxAgeMs) {
            // 删除过期文件
            unlinkSync(fullPath);
            removed++;
          }
        } catch (err) {
          logger.warn(`Error processing ${fullPath}: ${err}`);
        }
      }
    } catch (err) {
      logger.warn(`Error reading directory ${dir}: ${err}`);
    }
    
    return removed;
  }
}

// 导出单例
export const scheduler = new Scheduler();

export default scheduler;
