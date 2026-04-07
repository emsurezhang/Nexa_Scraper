# Nexa Scraper — 项目设计文档 v1.0

> 一个基于 Playwright 的模块化、可扩展网页抓取框架，支持 CLI 与 HTTP Server 两种运行模式。

---

## 目录
2. [架构总览](#2-架构总览)
3. [目录结构](#3-目录结构)
4. [核心模块设计](#4-核心模块设计)
5. [插件系统规范](#5-插件系统规范)
6. [CLI 设计](#6-cli-设计)
7. [HTTP Server API](#7-http-server-api)
8. [数据库 Schema](#8-数据库-schema)
9. [配置系统](#9-配置系统)
10. [日志与调试](#10-日志与调试)
11. [安全性设计](#11-安全性设计)
12. [技术栈](#12-技术栈)


## 2. 架构总览

```
┌─────────────────────────────────────────────────────┐
│                     CLI (commander.js)               │
│   nexa cookies | fetch | server | plugin             │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              Core Infrastructure                      │
│  Config → Bootstrap → Logger → DB → Queue            │
│                                                       │
│  ┌─────────────────┐   ┌──────────────────────────┐  │
│  │  Browser Pool   │   │   Capabilities           │  │
│  │  (Server mode)  │   │  CookieManager           │  │
│  │  BrowserContext │   │  MediaPipeline           │  │
│  │  Health Check   │   │  StealthInjector         │  │
│  └────────┬────────┘   └──────────────────────────┘  │
└───────────┼─────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────┐
│                  Plugin System                        │
│  PluginRegistry → URLMatcher → PluginExecutor        │
│                                                       │
│  domains/         general/          user-plugins/     │
│  douyin/          html-parser        (installed)      │
│  xiaohongshu/                                        │
│  youtube/                                            │
└──────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────┐
│               HTTP API Server (Fastify)               │
│  /fetch  /cookies  /plugins  /health  /metrics       │
└──────────────────────────────────────────────────────┘
```

---

## 3. 目录结构

```
nexa-scraper/
├── config/
│   ├── default.yaml            # 基础配置（提交到 git）
│   ├── dev.yaml                # 开发覆盖
│   ├── production.yaml         # 生产覆盖
│   └── .env.example            # 敏感配置模板
│
├── src/
│   ├── cli/                    # CLI 入口
│   │   ├── index.ts            # commander 根命令
│   │   └── commands/
│   │       ├── cookies.ts
│   │       ├── fetch.ts
│   │       ├── server.ts
│   │       └── plugin.ts
│   │
│   ├── server/                 # HTTP API
│   │   ├── index.ts            # Fastify 实例
│   │   ├── routes/
│   │   │   ├── fetch.ts
│   │   │   ├── cookies.ts
│   │   │   ├── plugins.ts
│   │   │   └── health.ts
│   │   └── middleware/
│   │       ├── auth.ts         # API Key 验证
│   │       └── rate-limit.ts
│   │
│   ├── core/
│   │   ├── config.ts           # node-config 封装
│   │   ├── logger.ts           # Pino 封装
│   │   ├── db.ts               # better-sqlite3 封装
│   │   ├── bootstrap.ts        # 启动检查（playwright、ffmpeg、whisper）
│   │   ├── queue.ts            # p-queue 任务队列
│   │   ├── scheduler.ts        # 定时清理任务
│   │   ├── plugin-contract.ts  # 插件 TypeScript 接口定义
│   │   ├── plugin-registry.ts  # 插件加载与路由
│   │   └── capabilities/
│   │       ├── browser-pool.ts      # 浏览器资源池（Server 模式）
│   │       ├── browser.ts           # Playwright 操作封装
│   │       ├── stealth.ts           # 反检测脚本注入
│   │       ├── cookie-manager.ts    # Cookie 增删查改
│   │       ├── media-pipeline.ts    # 媒体处理流水线
│   │       ├── media-processor.ts   # ffmpeg 音频分割
│   │       └── transcriber.ts       # Whisper 字幕生成
│   │
│   └── plugins/
│       ├── general/                  # 通用 HTML 解析（兜底）
│       │   ├── index.ts
│       │   └── extractor.ts
│       └── domains/
│           └── example-site/
│               ├── index.ts          # 插件入口，实现 NexaPlugin 接口
│               ├── url-matcher.ts
│               ├── extractor.ts      # 同时处理 list 和 single（通过 pageType 区分）
│               ├── login-state.ts
│               ├── waiting-strategy.ts
│               └── media-fetch.ts
│
├── dist/
├── data/
│   ├── cookies/                # Cookie JSON 文件（按 domain 存储）
│   ├── raw/                    # 原始抓取结果（按 domain/date 分目录）
│   └── nexa.db                 # SQLite 数据库
│
├── logs/
├── tmp/                        # 临时文件（自动清理）
├── debug/                      # 调试产物（TTL 自动清理）
│   └── fetch/
│       └── {date}_{time}_{hash}/
│           ├── meta.json
│           ├── 01-initial.png
│           ├── 02-post-wait.png
│           ├── 03-post-action.png  # 可选
│           ├── dom.html
│           ├── extract-raw.json
│           ├── extract-processed.json
│           ├── cookies-snapshot.json
│           └── network.har         # 可选
│
├── plugin.lock                 # 已安装插件锁定文件
├── scripts/
│   └── setup.sh
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── docs/
├── package.json
├── tsconfig.json
└── README.md
```

---

## 4. 核心模块设计

### 4.1 浏览器资源池 `browser-pool.ts`

仅在 Server 模式启用。CLI 模式每次 fetch 独立启动/关闭浏览器。

```typescript
interface PoolConfig {
  minSize: number;          // 最小空闲实例数，默认 1
  maxSize: number;          // 最大实例数，默认 5
  idleTimeoutMs: number;    // 空闲超时，默认 5 分钟
  healthCheckIntervalMs: number; // 健康检查间隔，默认 30 秒
}

interface PooledBrowser {
  id: string;
  browser: Browser;
  activeContexts: number;
  createdAt: Date;
  lastUsedAt: Date;
}

class BrowserPool {
  acquire(): Promise<BrowserContext>;
  release(context: BrowserContext): void;
  drain(): Promise<void>;            // graceful shutdown
  stats(): PoolStats;
}
```

**复用策略**：每个请求获取一个独立的 `BrowserContext`（隔离 Cookie/Storage），而不是共享 `Browser` 内部状态。`Browser` 实例在多个 Context 间共享以节省资源。

**健康检查**：定期对每个 `Browser` 实例执行 `browser.version()`，失败则关闭并重建。

**泄漏检测**：`Context` 超过 `maxContextLifetimeMs`（默认 3 分钟）未被释放，强制关闭并告警。

---

### 4.2 任务队列 `queue.ts`

```typescript
interface FetchTask {
  id: string;
  url: string;
  options: FetchOptions;
  retries: number;         // 当前重试次数
  maxRetries: number;      // 最大重试次数，默认 3
  priority: number;        // 优先级 0-9，0 最高
}

class TaskQueue {
  enqueue(task: FetchTask): Promise<FetchResult>;
  pause(): void;
  resume(): void;
  stats(): QueueStats;
}
```

**重试策略**：指数退避 + Jitter，基础间隔 1s，最大间隔 30s。
**可重试错误**：网络超时、浏览器 crash、目标网站 5xx。
**不可重试错误**：插件解析异常、配置错误、Cookie 失效（需人工干预）。

---

### 4.3 媒体处理流水线 `media-pipeline.ts`

```typescript
interface MediaPipelineOptions {
  url: string;
  outputDir: string;
  segmentDurationSec: number;   // 分段长度，默认 600s（10分钟）
  language?: string;             // 字幕语言提示，默认 'auto'
  keepIntermediates: boolean;    // 是否保留中间音频文件
}

interface PipelineResult {
  audioPath: string;
  segments: string[];
  subtitlePath: string;          // SRT 格式
  durationSec: number;
  cost: { transcribeSec: number; }
}

class MediaPipeline {
  // fetch audio → split segments → transcribe → merge subtitles
  run(options: MediaPipelineOptions): AsyncGenerator<PipelineEvent>;
}

type PipelineEvent =
  | { type: 'progress'; stage: 'fetch' | 'split' | 'transcribe'; percent: number }
  | { type: 'complete'; result: PipelineResult }
  | { type: 'error'; stage: string; error: Error };
```

**中间产物路径**：`tmp/media/{jobId}/`，流水线完成后根据 `keepIntermediates` 决定是否清理。

---

### 4.4 Stealth 注入 `stealth.ts`

不依赖第三方 Playwright 插件，通过 `page.addInitScript` 手动注入。

```typescript
const STEALTH_SCRIPTS = {
  // 移除 webdriver 标识
  webdriver: `Object.defineProperty(navigator, 'webdriver', { get: () => undefined })`,

  // Canvas 指纹噪声
  canvas: `/* 在 getImageData 结果中注入微量随机噪声 */`,

  // WebGL 指纹混淆
  webgl: `/* 覆盖 getParameter 返回模糊值 */`,

  // 修复 chrome runtime 对象（无头模式下为空）
  chromeRuntime: `window.chrome = { runtime: {} }`,

  // 修复 permissions API
  permissions: `/* navigator.permissions.query 返回 'granted' */`,
};

async function injectStealth(page: Page, options?: StealthOptions): Promise<void>;
```

**时区与语言**：通过 `context.newPage({ locale, timezoneId })` 设置，与代理 IP 的地理位置保持一致，由 `config` 中的 `browser.locale` 和 `browser.timezone` 控制。

---

## 5. 插件系统规范

### 5.1 插件接口 `plugin-contract.ts`

```typescript
/**
 * 所有 domain 插件必须实现此接口
 * general 插件实现 GeneralPlugin（pageType 始终返回 'unknown'，交给通用解析）
 */
export interface NexaPlugin {
  /** 插件元信息 */
  meta: PluginMeta;

  /** URL 匹配：返回 0-9 优先级（0最高），不匹配返回 null */
  matchUrl(url: string): number | null;

  /** 判断页面类型 */
  pageType(url: string, html: string): 'list' | 'single' | 'unknown';

  /** 等待页面动态内容加载完成 */
  waitForContent(page: Page): Promise<void>;

  /** 列表页数据提取 */
  extractList(html: string, url: string): Promise<ListItem[]>;

  /** 单内容页数据提取 */
  extractSingle(html: string, url: string): Promise<SingleItem>;

  /** 判断当前页面登录状态（可选） */
  checkLoginState?(page: Page): Promise<LoginState>;

  /** 媒体文件抓取（可选，适用于视频网站） */
  fetchMedia?(page: Page, url: string): Promise<MediaInfo>;
}

export interface PluginMeta {
  name: string;
  version: string;
  domains: string[];        // 负责的域名列表
  priority: number;         // 0-9，影响同 domain 多插件时的选择
  author?: string;
  requiresLogin?: boolean;
}

export type LoginState = 'logged-in' | 'logged-out' | 'unknown';

export interface ListItem {
  id: string;               // 内容唯一 ID（用于去重）
  url: string;
  title?: string;
  meta?: Record<string, unknown>;
}

export interface SingleItem {
  id: string;
  url: string;
  title: string;
  content: string;
  publishedAt?: string;     // ISO 8601
  author?: string;
  tags?: string[];
  stats?: Record<string, number>;
  raw?: Record<string, unknown>;
}

export interface MediaInfo {
  audioUrl?: string;
  videoUrl?: string;
  format: string;
  durationSec?: number;
}
```

### 5.2 插件注册与路由 `plugin-registry.ts`

```typescript
class PluginRegistry {
  /** 启动时扫描 src/plugins/domains/ 和 user-plugins/ 目录自动加载 */
  async load(): Promise<void>;

  /** 根据 URL 选择最高优先级的匹配插件，没有匹配则返回 GeneralPlugin */
  resolve(url: string): NexaPlugin;

  /** 列出所有已加载插件 */
  list(): PluginMeta[];
}
```

### 5.3 插件模板（`nexa plugin init` 生成）

```
plugins/{name}/
├── package.json             # { "name": "nexa-plugin-{name}", "main": "dist/index.js" }
├── tsconfig.json
├── src/
│   ├── index.ts             # export default class implements NexaPlugin
│   ├── url-matcher.ts
│   ├── extractor.ts
│   ├── waiting-strategy.ts
│   └── types.ts             # 插件私有类型
├── tests/
│   ├── extractor.test.ts
│   └── fixtures/            # HTML 快照，用于离线测试
└── README.md
```

---

## 6. CLI 设计

### 6.1 全局选项

```
nexa [全局选项] <命令> [命令选项]

全局选项：
  -h, --help        显示帮助
  -v, --version     显示版本
  -V, --verbose     日志级别（可叠加：-VVV = trace）
  -q, --quiet       静默模式（仅输出最终结果）
  -j, --json        强制 JSON 输出
  -c, --config      指定配置文件路径
  --no-color        禁用 ANSI 颜色
  -d, --dry-run     模拟运行
```

### 6.2 Cookies 命令组

```bash
# 交互式登录并保存 Cookie
nexa cookies add <domain>
# 打开可见浏览器 → 等待用户登录 → 用户输入回车或关闭浏览器 → 保存 Cookie

# 列出所有 Cookie
nexa cookies ls
# DOMAIN            STATUS    EXPIRES_IN    ITEMS    LAST_UPDATED
# douyin.com        valid     6d 12h        8        2h ago
# xiaohongshu.com   expired   -             5        3d ago

# 本地元数据检查（不发网络请求）
nexa cookies check <domain>

# 在线验证登录态（启动浏览器加载页面）
nexa cookies validate <domain> [--headless]

# 删除
nexa cookies rm <domain> [--yes]

# 导出（不指定 domain 则全部导出）
nexa cookies export [domain...] [--output ./cookies.json]

# 导入（不指定 domain 则按文件内容全量覆盖）
nexa cookies import [domain...] --input ./cookies.json
```

### 6.3 Fetch 命令

```bash
nexa fetch <url|--batch file> [选项]

选项：
  --debug                   输出调试产物到 debug/ 目录
  --debug-dir <path>        自定义调试输出目录
  --screenshot <mode>       截图策略：none|viewport|full（默认 none）
  --output-json <path>      结果输出到文件（默认 stdout）
  --format <mode>           输出格式：raw|delta|full（默认 raw）
  --proxy <url>             代理地址
  --limit <n>               列表页最大提取条数
  --headless <bool>         是否无头（默认 true）
  --plugin <name>           强制指定插件（跳过自动匹配）
  --batch <file>            批量抓取，每行一个 URL
  --parallel <n>            批量并发数（默认 3，受队列限制）
  --output-dir <path>       批量结果输出目录
  --retry <n>               最大重试次数（默认 3）
  --timeout <ms>            单次抓取超时（默认 30000）
  -d, --dry-run             模拟运行（验证插件匹配，不启动浏览器）
```

**`--format delta` 说明**：与数据库中同 URL 的上次抓取结果进行差分，输出新增/删除/变更的字段，格式：

```json
{
  "url": "https://...",
  "fetchedAt": "2026-04-07T18:05:33Z",
  "previousFetchedAt": "2026-04-01T10:00:00Z",
  "added": [ { "id": "xxx", ... } ],
  "removed": [ { "id": "yyy" } ],
  "changed": [ { "id": "zzz", "diff": { "title": { "from": "A", "to": "B" } } } ]
}
```

### 6.4 Server 命令组

```bash
nexa server start [--port 3000] [--host 0.0.0.0] [--daemon] [--log ./logs/server.log]
nexa server stop [--force]
nexa server restart [--graceful]
nexa server status
# 输出：
# Status:    running (PID 12345)
# Uptime:    2h 34m
# Memory:    245 MB
# Browser Pool: 3/5 active
# Queue:     2 pending, 0 failed
# Requests:  1,234 total, 12 errors

nexa server logs [--follow] [--level error] [--since 1h]
```

### 6.5 Plugin 命令组

```bash
nexa plugin ls [--enabled-only] [--json]
# NAME              VERSION   DOMAINS                 PRIORITY  STATUS
# douyin-core       1.2.0     douyin.com              3         active
# xhs-beta          0.5.0     xiaohongshu.com         5         disabled
# general           -         * (fallback)            9         active

nexa plugin install <source>
# source 支持：
#   ./local-plugin/               本地目录
#   https://github.com/user/repo  Git 仓库
#   npm:nexa-plugin-tiktok        npm 包

nexa plugin enable <name>
nexa plugin disable <name>
nexa plugin uninstall <name> [--yes]
nexa plugin info <name> [--json]
nexa plugin test <name> [--watch] [--url <url>]  # 用真实 URL 或 fixture 运行测试
nexa plugin init <name> [--template typescript|javascript]
```

---

## 7. HTTP Server API

所有接口需要在 Header 中携带 `X-Nexa-Token: <token>`（除 `/health` 和 `/metrics`）。

### 7.1 接口总览

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/health` | 健康检查（无鉴权） |
| `GET` | `/metrics` | Prometheus 格式指标（无鉴权） |
| `POST` | `/fetch` | 提交抓取任务 |
| `GET` | `/fetch/:jobId` | 查询任务状态与结果 |
| `DELETE` | `/fetch/:jobId` | 取消任务 |
| `GET` | `/cookies` | 列出所有 Cookie |
| `POST` | `/cookies/:domain` | 触发交互式登录（Server 需接显示器或 VNC） |
| `DELETE` | `/cookies/:domain` | 删除 Cookie |
| `GET` | `/plugins` | 列出已安装插件 |
| `GET` | `/plugins/:name` | 插件详情 |

### 7.2 关键接口示例

#### `POST /fetch`

```json
// Request
{
  "url": "https://douyin.com/user/123",
  "options": {
    "format": "raw",
    "limit": 50,
    "debug": false,
    "screenshot": "none",
    "proxy": "http://127.0.0.1:7890",
    "headless": true,
    "plugin": null,
    "timeout": 30000
  }
}

// Response 202 Accepted
{
  "jobId": "job_a1b2c3d4",
  "status": "queued",
  "position": 2,
  "estimatedWaitSec": 5
}
```

#### `GET /fetch/:jobId`

```json
// Response 200（任务完成）
{
  "jobId": "job_a1b2c3d4",
  "status": "completed",  // queued | running | completed | failed | cancelled
  "url": "https://douyin.com/user/123",
  "startedAt": "2026-04-07T18:05:33Z",
  "completedAt": "2026-04-07T18:05:36Z",
  "durationMs": 3200,
  "plugin": "douyin-core",
  "result": { /* SingleItem 或 ListItem[] */ },
  "error": null
}
```

#### `GET /health`

```json
{
  "status": "ok",  // ok | degraded | down
  "version": "1.0.0",
  "uptime": 9240,
  "browserPool": { "active": 2, "idle": 1, "max": 5 },
  "queue": { "pending": 1, "running": 2 },
  "db": "ok"
}
```

---

## 8. 数据库 Schema

使用 `better-sqlite3`，数据库文件：`data/nexa.db`。

```sql
-- 抓取任务记录
CREATE TABLE fetch_jobs (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  plugin      TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',
  options     TEXT,                    -- JSON
  result      TEXT,                    -- JSON
  error       TEXT,
  retries     INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,        -- Unix timestamp ms
  started_at  INTEGER,
  completed_at INTEGER
);

-- 原始抓取结果（用于 delta 对比）
CREATE TABLE fetch_results (
  id              TEXT PRIMARY KEY,    -- {domain}:{content_id}
  url             TEXT NOT NULL,
  domain          TEXT NOT NULL,
  content_id      TEXT NOT NULL,       -- 插件返回的 item.id
  data            TEXT NOT NULL,       -- JSON（SingleItem 或 ListItem）
  fetched_at      INTEGER NOT NULL,
  UNIQUE(domain, content_id)
);

-- Cookie 元数据（实际 Cookie 存文件，这里存管理信息）
CREATE TABLE cookie_meta (
  domain      TEXT PRIMARY KEY,
  status      TEXT NOT NULL,           -- valid | expired | unknown
  item_count  INTEGER,
  expires_at  INTEGER,                 -- Unix timestamp ms
  updated_at  INTEGER NOT NULL
);

-- 已安装插件
CREATE TABLE plugins (
  name        TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  source      TEXT,                    -- 安装来源
  enabled     INTEGER DEFAULT 1,
  installed_at INTEGER NOT NULL,
  meta        TEXT                     -- JSON（PluginMeta）
);

-- 索引
CREATE INDEX idx_fetch_jobs_status ON fetch_jobs(status, created_at);
CREATE INDEX idx_fetch_results_domain ON fetch_results(domain, fetched_at);
```

---

## 9. 配置系统

使用分层配置：`default.yaml` → `{env}.yaml` → 环境变量覆盖。

```yaml
# config/default.yaml

app:
  name: nexa-scraper
  version: "1.0.0"
  env: development       # 由 NODE_ENV 覆盖

browser:
  headless: true
  locale: zh-CN
  timezone: Asia/Shanghai
  userAgent: null        # null = 使用 Playwright 默认值
  viewportWidth: 1280
  viewportHeight: 800
  stealth:
    enabled: true
    injectCanvas: true
    injectWebGL: true

pool:                    # 仅 Server 模式
  minSize: 1
  maxSize: 5
  idleTimeoutMs: 300000
  healthCheckIntervalMs: 30000
  maxContextLifetimeMs: 180000

queue:
  concurrency: 3
  retryMax: 3
  retryBaseDelayMs: 1000
  retryMaxDelayMs: 30000

server:
  host: 127.0.0.1
  port: 3000
  auth:
    enabled: true
    token: ""            # 必须通过环境变量 NEXA_TOKEN 设置
  rateLimit:
    max: 100             # 每分钟最大请求数
    windowMs: 60000

storage:
  dataDir: ./data
  logsDir: ./logs
  tmpDir: ./tmp
  debugDir: ./debug
  debugTtlDays: 7        # debug 产物保留天数
  tmpTtlHours: 24        # tmp 文件保留小时数

fetch:
  defaultTimeout: 30000
  defaultScreenshot: none
  defaultFormat: raw
  defaultLimit: 100

media:
  segmentDurationSec: 600
  keepIntermediates: false
  whisperModel: base     # tiny | base | small | medium | large

logging:
  level: info            # trace | debug | info | warn | error
  pretty: true           # 生产环境设为 false（JSON 格式）
```

---

## 10. 日志与调试

### 10.1 日志格式

**开发环境（pretty）**：
```
[18:05:33.123] INFO  [fetch] Target: douyin.com/user/123
[18:05:33.124] INFO  [cookie] Loading cookies for douyin.com ✓ (8 cookies)
[18:05:34.201] INFO  [browser] Launching browser (headless: true, stealth: true)
[18:05:35.012] INFO  [plugin] Matched plugin: douyin-core@1.2.0 (priority: 3)
[18:05:35.234] INFO  [wait] Waiting for selector: .feed-list... ✓ (1.2s)
[18:05:36.111] INFO  [extract] 15 items extracted
[18:05:36.112] INFO  [storage] Saved to data/raw/douyin.com/2026-04-07/
[18:05:36.113] DEBUG [debug] Artifacts saved to debug/fetch/2026-04-07_18-05-33_a1b2c3/
[18:05:36.114] INFO  [fetch] Completed in 3.2s ✓
```

**生产环境（JSON + Pino）**：每行一个 JSON 对象，含 `level`、`time`、`module`、`jobId`、`msg` 等字段，便于 ELK/Loki 接入。

### 10.2 调试产物结构

```
debug/fetch/{YYYY-MM-DD}_{HH-MM-SS}_{6位hash}/
├── meta.json                # { url, plugin, options, timestamps, version }
├── 01-initial.png           # 页面初始状态
├── 02-post-wait.png         # waitForContent 完成后
├── 03-post-action.png       # 交互操作后（如滚动加载，可选）
├── dom.html                 # 最终 outerHTML
├── extract-raw.json         # 插件 extract* 方法的原始返回值
├── extract-processed.json   # 经过 normalize/validate 后的数据
├── cookies-snapshot.json    # 本次使用的 Cookie（敏感值脱敏）
└── network.har              # 全部网络请求记录（需 --debug-har 开启）
```

---

## 11. 安全性设计

### 11.1 API 鉴权

Server API 使用静态 Token 鉴权。Token 通过环境变量 `NEXA_TOKEN` 注入，禁止写入配置文件提交到 git。

```
X-Nexa-Token: your-secret-token-here
```

未来可扩展为 JWT 或 mTLS，当前阶段静态 Token 满足内网部署需求。

### 11.2 Cookie 安全

- Cookie 文件存储在 `data/cookies/{domain}.json`，权限设为 `600`（仅 owner 可读写）
- 调试产物中的 Cookie Snapshot 对 `value` 字段做脱敏处理（仅保留前4位 + `****`）
- 不在日志中输出 Cookie 原始值

### 11.3 代理配置

- 代理地址支持通过配置文件或 CLI `--proxy` 指定
- 代理认证信息（用户名/密码）仅从环境变量读取，不落盘

### 11.4 依赖安全

- 定期运行 `npm audit`，CI 中强制通过
- Playwright 和 Chromium 版本锁定，避免自动升级引入 breaking change

---

## 12. 技术栈

| 分类 | 选型 | 理由 |
|------|------|------|
| 语言 | TypeScript 5.x | 类型安全，IDE 友好 |
| 运行时 | Node.js 20 LTS | 长期支持 |
| 浏览器自动化 | Playwright | 比 Puppeteer 更稳定，原生支持多浏览器 |
| HTTP 框架 | Fastify | 比 Express 快 2-3x，内置 JSON Schema 验证 |
| CLI 框架 | Commander.js | 生态成熟，子命令支持完善 |
| 日志 | Pino | 性能最优的 Node.js 日志库 |
| 数据库 | better-sqlite3 | 同步 API，零配置，适合单节点部署 |
| 任务队列 | p-queue | 轻量，支持优先级和并发控制 |
| 配置 | node-config | 分层配置，支持环境覆盖 |
| 测试 | Vitest | 速度快，与 TypeScript 配合好 |
| 媒体处理 | ffmpeg (CLI) | 业界标准 |
| 转录 | Whisper (openai/whisper) | 本地运行，隐私安全 |

---

*文档版本：v1.0 · 2026-04-07*