# Nexa Scraper

基于 Playwright 的模块化、可扩展网页抓取框架，支持 CLI 与 HTTP Server 两种运行模式。

## 特性

- 🔌 **插件化架构** - 易于扩展的插件系统，支持自定义抓取逻辑
- 🌐 **双模式运行** - CLI 模式适合开发调试，Server 模式适合生产部署
- 🍪 **Cookie 管理** - 完整的 Cookie 增删查改和登录态管理
- 🎭 **Stealth 模式** - 内置反检测脚本，降低被识别风险
- 🔄 **任务队列** - 支持优先级和并发控制的任务队列
- 💾 **数据持久化** - SQLite 数据库支持，支持增量更新
- 📊 **媒体处理** - 音频下载、分段、字幕生成流水线
- 📈 **监控指标** - Prometheus 格式指标导出

## 快速开始

### 安装

```bash
# 克隆项目
git clone <repo-url>
cd nexa-scraper

# 安装依赖
npm install

# 安装 Playwright 浏览器
npx playwright install chromium

# 配置环境变量
cp config/.env.example config/.env
# 编辑 config/.env 设置 NEXA_TOKEN

# 编译 TypeScript
npm run build
```

### CLI 使用

```bash
# 抓取单个页面
nexa fetch "https://example.com/article/123"

# 使用调试模式（保存截图和 DOM）
nexa fetch "https://example.com/article/123" --debug

# 批量抓取
nexa fetch --batch ./urls.txt --parallel 3

# 管理 Cookie
nexa cookies add example.com
nexa cookies ls

# 管理插件
nexa plugin ls
nexa plugin init my-plugin
```

### Server 模式

```bash
# 启动服务器
nexa server start

# 后台运行
nexa server start --daemon

# 查看状态
nexa server status

# 停止服务器
nexa server stop
```

### HTTP API

```bash
# 提交抓取任务
curl -X POST http://localhost:3000/fetch \
  -H "X-Nexa-Token: your-token" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

# 查询任务状态
curl http://localhost:3000/fetch/job_abc123 \
  -H "X-Nexa-Token: your-token"
```

## 项目结构

```
nexa-scraper/
├── config/                 # 配置文件
│   ├── default.yaml
│   └── .env
├── src/
│   ├── cli/               # CLI 命令
│   │   ├── index.ts
│   │   └── commands/
│   ├── server/            # HTTP API Server
│   │   ├── index.ts
│   │   └── routes/
│   ├── core/              # 核心模块
│   │   ├── config.ts
│   │   ├── logger.ts
│   │   ├── db.ts
│   │   ├── bootstrap.ts
│   │   ├── queue.ts
│   │   ├── plugin-contract.ts
│   │   ├── plugin-registry.ts
│   │   └── capabilities/  # 能力模块
│   │       ├── browser.ts
│   │       ├── browser-pool.ts
│   │       ├── stealth.ts
│   │       ├── cookie-manager.ts
│   │       └── media-pipeline.ts
│   └── plugins/           # 插件
│       ├── general/       # 通用插件
│       └── domain/        # 域名插件
├── data/                  # 数据存储
├── logs/                  # 日志
└── tmp/                   # 临时文件
```

## 开发插件

```bash
# 创建新插件
nexa plugin init my-site

# 编辑插件
code src/plugins/domain/my-site/index.ts

# 测试插件
nexa plugin test my-site --url "https://example.com"
```

插件需要实现 `NexaPlugin` 接口：

```typescript
export interface NexaPlugin {
  meta: PluginMeta;
  matchUrl(url: string): number | null;
  pageType(url: string, html: string): 'list' | 'single' | 'unknown';
  waitForContent(page: Page): Promise<void>;
  extractList(html: string, url: string): Promise<ListItem[]>;
  extractSingle(html: string, url: string): Promise<SingleItem>;
}
```

## 配置

配置文件位于 `config/` 目录，支持分层配置：

- `default.yaml` - 默认配置
- `dev.yaml` - 开发环境覆盖
- `production.yaml` - 生产环境覆盖
- `.env` - 敏感配置（不提交到 git）

### 关键配置项

```yaml
browser:
  headless: true        # 无头模式
  locale: zh-CN         # 语言
  timezone: Asia/Shanghai

pool:                   # 浏览器资源池（仅 Server 模式）
  minSize: 1
  maxSize: 5

queue:
  concurrency: 3        # 并发数
  retryMax: 3           # 最大重试次数

server:
  port: 3000
  auth:
    enabled: true
    token: ""           # 从环境变量 NEXA_TOKEN 读取
```

## 环境要求

- Node.js >= 20
- Playwright 浏览器
- ffmpeg（可选，用于媒体处理）
- Whisper（可选，用于语音转录）

## License

MIT
