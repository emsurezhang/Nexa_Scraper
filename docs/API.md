## 1. 抓取任务接口

### POST /fetch
提交一个新的抓取任务。

- **请求体**（JSON）:
  ```json
  {
    "url": "https://example.com",
    "options": { /* 可选，插件相关参数 */ }
  }
  ```
- **响应**（202 Accepted）:
  ```json
  {
    "jobId": "任务ID",
    "status": "queued",
    "position": 1,
    "estimatedWaitSec": 5
  }
  ```

### GET /fetch/:jobId
查询任务状态和结果。

- **响应**（200 OK）:
  ```json
  {
    "jobId": "任务ID",
    "status": "queued|running|completed|failed",
    "url": "https://example.com",
    "startedAt": "2024-01-01T12:00:00.000Z",
    "completedAt": "2024-01-01T12:01:00.000Z",
    "plugin": "插件名",
    "result": { /* 任务结果，completed 时有 */ },
    "error": "错误信息"
  }
  ```

### DELETE /fetch/:jobId
取消一个排队或运行中的任务。

- **响应**（200 OK 或 400/404 错误）:
  ```json
  {
    "message": "Job cancelled",
    "jobId": "任务ID"
  }
  ```

---

## 2. Cookie 管理接口

### GET /cookies
列出所有已保存的 Cookie 信息。

- **响应**（200 OK）:
  ```json
  {
    "cookies": [
      {
        "domain": "example.com",
        "status": "valid|expired|unknown",
        "itemCount": 5,
        "expiresAt": "2024-12-31T23:59:59.000Z",
        "updatedAt": "2024-01-01T12:00:00.000Z"
      }
    ]
  }
  ```

### GET /cookies/:domain
获取指定域名的 Cookie 元信息。

- **响应**（200 OK 或 404）:
  ```json
  {
    "domain": "example.com",
    "status": "valid",
    "itemCount": 5,
    "expiresAt": "2024-12-31T23:59:59.000Z",
    "updatedAt": "2024-01-01T12:00:00.000Z"
  }
  ```

### POST /cookies/:domain
触发交互式登录（需服务器有图形界面）。

- **请求体**（可选）:
  ```json
  {
    "headless": false
  }
  ```
- **响应**（202 Accepted）:
  ```json
  {
    "message": "Interactive login initiated",
    "domain": "example.com",
    "note": "This requires a display (X11 or VNC) on the server",
    "status": "pending"
  }
  ```

### DELETE /cookies/:domain
删除指定域名的 Cookie。

- **响应**（200 OK）:
  ```json
  {
    "message": "Cookies deleted",
    "domain": "example.com"
  }
  ```