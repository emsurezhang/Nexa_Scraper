/**
 * 数据库模块
 * 使用 better-sqlite3 进行同步数据库操作
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import config, { configRootDir } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger({ module: 'db' });

const DATA_DIR = resolve(configRootDir, '..', config.storage.dataDir);
const DB_PATH = resolve(DATA_DIR, 'nexa.db');

// 确保数据目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// 数据库实例
let dbInstance: Database.Database | null = null;

export interface FetchJob {
  id: string;
  url: string;
  plugin: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  options: string | null;
  result: string | null;
  error: string | null;
  retries: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface FetchResult {
  id: string;
  url: string;
  domain: string;
  content_id: string;
  data: string;
  fetched_at: number;
}

export interface CookieMeta {
  domain: string;
  status: 'valid' | 'expired' | 'unknown';
  item_count: number;
  expires_at: number | null;
  updated_at: number;
}

export interface PluginRecord {
  name: string;
  version: string;
  source: string | null;
  enabled: number;
  installed_at: number;
  meta: string | null;
}

// 初始化数据库
export function initDatabase(): Database.Database {
  if (dbInstance) return dbInstance;

  logger.info(`Initializing database at ${DB_PATH}`);
  
  dbInstance = new Database(DB_PATH);
  dbInstance.pragma('journal_mode = WAL');
  
  createTables();
  
  logger.info('Database initialized successfully');
  return dbInstance;
}

// 创建表结构
function createTables(): void {
  if (!dbInstance) return;

  // 抓取任务记录表
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS fetch_jobs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      plugin TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      options TEXT,
      result TEXT,
      error TEXT,
      retries INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    )
  `);

  // 抓取结果表（用于 delta 对比）
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS fetch_results (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      domain TEXT NOT NULL,
      content_id TEXT NOT NULL,
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      UNIQUE(domain, content_id)
    )
  `);

  // Cookie 元数据表
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS cookie_meta (
      domain TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      item_count INTEGER,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);

  // 插件表
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
      name TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      source TEXT,
      enabled INTEGER DEFAULT 1,
      installed_at INTEGER NOT NULL,
      meta TEXT
    )
  `);

  // 创建索引
  dbInstance.exec(`
    CREATE INDEX IF NOT EXISTS idx_fetch_jobs_status ON fetch_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_fetch_results_domain ON fetch_results(domain, fetched_at);
  `);

  logger.debug('Database tables created');
}

// 获取数据库实例
export function getDatabase(): Database.Database {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

// 关闭数据库连接
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info('Database connection closed');
  }
}

// 任务相关操作
export const jobOperations = {
  create(job: Omit<FetchJob, 'created_at'>): FetchJob {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO fetch_jobs (id, url, plugin, status, options, result, error, retries, created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const now = Date.now();
    stmt.run(
      job.id,
      job.url,
      job.plugin,
      job.status,
      job.options,
      job.result,
      job.error,
      job.retries,
      now,
      job.started_at,
      job.completed_at
    );
    
    return { ...job, created_at: now };
  },

  get(id: string): FetchJob | undefined {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM fetch_jobs WHERE id = ?');
    return stmt.get(id) as FetchJob | undefined;
  },

  updateStatus(
    id: string,
    status: FetchJob['status'],
    updates: Partial<Pick<FetchJob, 'result' | 'error' | 'started_at' | 'completed_at'>> = {}
  ): void {
    const db = getDatabase();
    const fields: string[] = ['status = ?'];
    const values: unknown[] = [status];

    if (updates.result !== undefined) {
      fields.push('result = ?');
      values.push(updates.result);
    }
    if (updates.error !== undefined) {
      fields.push('error = ?');
      values.push(updates.error);
    }
    if (updates.started_at !== undefined) {
      fields.push('started_at = ?');
      values.push(updates.started_at);
    }
    if (updates.completed_at !== undefined) {
      fields.push('completed_at = ?');
      values.push(updates.completed_at);
    }

    values.push(id);
    const stmt = db.prepare(`UPDATE fetch_jobs SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  },

  incrementRetries(id: string): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE fetch_jobs SET retries = retries + 1 WHERE id = ?');
    stmt.run(id);
  },

  list(options: { status?: FetchJob['status']; limit?: number; offset?: number } = {}): FetchJob[] {
    const db = getDatabase();
    let sql = 'SELECT * FROM fetch_jobs';
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (options.status) {
      conditions.push('status = ?');
      values.push(options.status);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      values.push(options.limit);
    }

    if (options.offset) {
      sql += ' OFFSET ?';
      values.push(options.offset);
    }

    const stmt = db.prepare(sql);
    return stmt.all(...values) as FetchJob[];
  },

  delete(id: string): void {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM fetch_jobs WHERE id = ?');
    stmt.run(id);
  },
};

// 结果相关操作
export const resultOperations = {
  save(result: Omit<FetchResult, 'id'>): FetchResult {
    const db = getDatabase();
    const id = `${result.domain}:${result.content_id}`;
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO fetch_results (id, url, domain, content_id, data, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(id, result.url, result.domain, result.content_id, result.data, result.fetched_at);
    
    return { ...result, id };
  },

  getByDomainAndContentId(domain: string, contentId: string): FetchResult | undefined {
    const db = getDatabase();
    const id = `${domain}:${contentId}`;
    const stmt = db.prepare('SELECT * FROM fetch_results WHERE id = ?');
    return stmt.get(id) as FetchResult | undefined;
  },

  listByDomain(domain: string, limit = 100): FetchResult[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM fetch_results WHERE domain = ? ORDER BY fetched_at DESC LIMIT ?');
    return stmt.all(domain, limit) as FetchResult[];
  },
};

// Cookie 相关操作
export const cookieOperations = {
  save(meta: Omit<CookieMeta, 'updated_at'>): CookieMeta {
    const db = getDatabase();
    const now = Date.now();
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO cookie_meta (domain, status, item_count, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(meta.domain, meta.status, meta.item_count, meta.expires_at, now);
    
    return { ...meta, updated_at: now };
  },

  get(domain: string): CookieMeta | undefined {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM cookie_meta WHERE domain = ?');
    return stmt.get(domain) as CookieMeta | undefined;
  },

  list(): CookieMeta[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM cookie_meta ORDER BY updated_at DESC');
    return stmt.all() as CookieMeta[];
  },

  delete(domain: string): void {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM cookie_meta WHERE domain = ?');
    stmt.run(domain);
  },
};

// 插件相关操作
export const pluginOperations = {
  save(record: Omit<PluginRecord, 'installed_at'> & { installed_at?: number }): PluginRecord {
    const db = getDatabase();
    const now = record.installed_at || Date.now();
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO plugins (name, version, source, enabled, installed_at, meta)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(record.name, record.version, record.source, record.enabled, now, record.meta);
    
    return { ...record, installed_at: now };
  },

  get(name: string): PluginRecord | undefined {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM plugins WHERE name = ?');
    return stmt.get(name) as PluginRecord | undefined;
  },

  list(enabledOnly = false): PluginRecord[] {
    const db = getDatabase();
    let sql = 'SELECT * FROM plugins';
    if (enabledOnly) {
      sql += ' WHERE enabled = 1';
    }
    sql += ' ORDER BY name';
    const stmt = db.prepare(sql);
    return stmt.all() as PluginRecord[];
  },

  setEnabled(name: string, enabled: boolean): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE plugins SET enabled = ? WHERE name = ?');
    stmt.run(enabled ? 1 : 0, name);
  },

  delete(name: string): void {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM plugins WHERE name = ?');
    stmt.run(name);
  },
};

export default {
  init: initDatabase,
  get: getDatabase,
  close: closeDatabase,
  jobs: jobOperations,
  results: resultOperations,
  cookies: cookieOperations,
  plugins: pluginOperations,
};
