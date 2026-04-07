/**
 * 配置管理模块
 * 使用 node-config 进行分层配置管理
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';
import { config as dotenvConfig } from 'dotenv';

// 加载 .env 文件
dotenvConfig({ path: resolve(process.cwd(), 'config/.env') });

export interface BrowserConfig {
  headless: boolean;
  locale: string;
  timezone: string;
  userAgent: string | null;
  viewportWidth: number;
  viewportHeight: number;
  stealth: {
    enabled: boolean;
    injectCanvas: boolean;
    injectWebGL: boolean;
  };
}

export interface PoolConfig {
  minSize: number;
  maxSize: number;
  idleTimeoutMs: number;
  healthCheckIntervalMs: number;
  maxContextLifetimeMs: number;
}

export interface QueueConfig {
  concurrency: number;
  retryMax: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  auth: {
    enabled: boolean;
    token: string;
  };
  rateLimit: {
    max: number;
    windowMs: number;
  };
}

export interface StorageConfig {
  dataDir: string;
  logsDir: string;
  tmpDir: string;
  debugDir: string;
  debugTtlDays: number;
  tmpTtlHours: number;
}

export interface FetchConfig {
  defaultTimeout: number;
  defaultScreenshot: 'none' | 'viewport' | 'full';
  defaultFormat: 'raw' | 'delta' | 'full';
  defaultLimit: number;
}

export interface MediaConfig {
  segmentDurationSec: number;
  keepIntermediates: boolean;
  whisperModel: string;
  whisperModelDir: string;
  whisperLanguage: string;
}

export interface LoggingConfig {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  pretty: boolean;
}

export interface AppConfig {
  name: string;
  version: string;
  env: string;
}

export interface Config {
  app: AppConfig;
  browser: BrowserConfig;
  pool: PoolConfig;
  queue: QueueConfig;
  server: ServerConfig;
  storage: StorageConfig;
  fetch: FetchConfig;
  media: MediaConfig;
  logging: LoggingConfig;
}

const CONFIG_DIR = resolve(process.cwd(), 'config');

function loadYamlFile(filename: string): Record<string, unknown> | null {
  const path = resolve(CONFIG_DIR, filename);
  if (!existsSync(path)) return null;
  
  try {
    const content = readFileSync(path, 'utf-8');
    return parse(content) as Record<string, unknown>;
  } catch (error) {
    console.error(`Failed to load config file: ${path}`, error);
    return null;
  }
}

function mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = mergeConfig(
        (result[key] as Record<string, unknown>) || {},
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  // NEXA_TOKEN 环境变量覆盖 server.auth.token
  if (process.env.NEXA_TOKEN) {
    if (!config.server) config.server = {};
    if (!(config.server as Record<string, unknown>).auth) {
      (config.server as Record<string, unknown>).auth = {};
    }
    ((config.server as Record<string, unknown>).auth as Record<string, unknown>).token = process.env.NEXA_TOKEN;
  }

  // NODE_ENV 覆盖 app.env
  if (process.env.NODE_ENV) {
    if (!config.app) config.app = {};
    (config.app as Record<string, unknown>).env = process.env.NODE_ENV;
  }

  return config;
}

function loadConfig(): Config {
  // 加载默认配置
  const defaultConfig = loadYamlFile('default.yaml') || {};
  
  // 根据环境加载覆盖配置
  const env = process.env.NODE_ENV || 'development';
  const envFile = env === 'production' ? 'production.yaml' : 'dev.yaml';
  const envConfig = loadYamlFile(envFile) || {};
  
  // 合并配置
  let config = mergeConfig(defaultConfig, envConfig);
  
  // 应用环境变量覆盖
  config = applyEnvOverrides(config);
  
  return config as unknown as Config;
}

export const config = loadConfig();

export default config;
