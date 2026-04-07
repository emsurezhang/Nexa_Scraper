/**
 * 日志模块
 * 使用 Pino 进行高性能日志记录
 */

import { pino, type Logger as PinoLogger, type Level } from 'pino';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import config from './config.js';

const LOGS_DIR = resolve(process.cwd(), config.storage.logsDir);

// 确保日志目录存在
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

// 日志级别映射（从 CLI 的 -V 次数到 pino 级别）
export const verbosityToLevel: Record<number, Level> = {
  0: 'info',    // 默认
  1: 'debug',   // -V
  2: 'debug',   // -VV
  3: 'trace',   // -VVV
};

export interface LoggerOptions {
  module?: string;
  jobId?: string;
  verbosity?: number;
}

let globalVerbosity = 0;

export function setGlobalVerbosity(verbosity: number): void {
  globalVerbosity = Math.min(verbosity, 3);
}

export function getLogLevel(): Level {
  const level = verbosityToLevel[globalVerbosity] || config.logging.level;
  return level as Level;
}

// 创建基础 logger
function createBaseLogger(): PinoLogger {
  const level = getLogLevel();
  const destination = pino.destination({ dest: 2, sync: false });
  
  if (config.logging.pretty) {
    // 开发环境：使用 pretty 格式
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '{module}{jobId} {msg}',
          destination: 2,
        },
      },
    });
  } else {
    // 生产环境：JSON 格式
    return pino({
      level,
      base: {
        app: config.app.name,
        version: config.app.version,
      },
    }, destination);
  }
}

let baseLogger = createBaseLogger();

// 重新配置 logger（用于动态调整日志级别）
export function reconfigureLogger(): void {
  baseLogger = createBaseLogger();
}

// 创建子 logger
export function createLogger(options: LoggerOptions = {}): Logger {
  const childBindings: Record<string, string> = {};
  
  if (options.module) {
    childBindings.module = options.module;
  }
  if (options.jobId) {
    childBindings.jobId = options.jobId;
  }
  
  const pinoLogger = baseLogger.child(childBindings);
  
  return new Logger(pinoLogger, options);
}

export class Logger {
  constructor(
    private readonly pinoLogger: PinoLogger,
    private readonly options: LoggerOptions = {}
  ) {}

  trace(msg: string, ...args: unknown[]): void {
    this.pinoLogger.trace(msg, ...args);
  }

  debug(msg: string, ...args: unknown[]): void {
    this.pinoLogger.debug(msg, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    this.pinoLogger.info(msg, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.pinoLogger.warn(msg, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    this.pinoLogger.error(msg, ...args);
  }

  fatal(msg: string, ...args: unknown[]): void {
    this.pinoLogger.fatal(msg, ...args);
  }

  // 创建子 logger（添加更多上下文）
  child(bindings: Record<string, string>): Logger {
    const newBindings = { ...bindings };
    if (this.options.module) {
      newBindings.module = this.options.module;
    }
    if (this.options.jobId) {
      newBindings.jobId = this.options.jobId;
    }
    return new Logger(this.pinoLogger.child(newBindings), { ...this.options, ...bindings });
  }
}

// 默认导出根 logger
export const logger = createLogger({ module: 'core' });

export default logger;
