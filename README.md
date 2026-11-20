# PenguinWebUI

HuHoBot 独立服务器的网页管理界面。Cloudflare Worker 托管页面，并通过端到端加密的 WebSocket 中继把浏览器操作转发给游戏服务器上的 HuHoBot 插件。

- 无账号系统，无需注册登录。管理权限来自服务器现场生成的一次性编辑链接和验证码。
- 数据全程端到端加密。加密密钥只出现在编辑链接的 URL 片段、浏览器标签页存储和插件中，Worker 只转发密文。
- 状态持久化在 SQLite-backed Durable Objects 中，不依赖 Redis 或数据库。

## 功能

| 页面 | 能力 |
| --- | --- |
| 服务器概览 | 服务器名称、平台、插件版本、机器人连接状态、在线玩家、已连接群组 |
| 配置管理 | 编辑全局配置、保存、重新加载；支持按群组覆盖命令配置 |
| 命令控制台 | 以管理员身份执行服务器命令，并保留本次会话的结果历史 |
| QQ 扫码绑定 | 启动或取消扫码流程，显示来自授权服务器的 PNG 二维码 |
| 版本更新 | 查看插件版本和远程更新检查结果，不会自动安装更新 |

## 工作原理

```text
浏览器 ──HTTPS/WebSocket──> Cloudflare Worker ──WebSocket──> HuHoBot 插件（游戏服务器）
          (只转发密文)        EditorChannel / BrowserSession
```

1. 服务器执行 `/huhobot webui`，插件向 Worker 申请临时频道，得到一次性编辑链接。
2. 浏览器打开链接后建立临时网页会话，页面显示一次性验证码。
3. 在服务器执行 `/huhobot webui <验证码>` 确认此网页会话，之后才开放管理操作。
4. 浏览器与插件通过 `/ws/editor/<频道ID>` 等路径连接；请求和响应使用 AES-GCM 加密，附加数据绑定频道、消息类型和请求 ID。
5. 频道、网页会话或服务器连接失效后，管理权限随之失效；未收到响应的操作不会被自动重试。

关键约束：

- 频道有效期和网页会话有效期均为 45 分钟，验证码 5 分钟内有效且只能使用一次。
- 插件每 2 秒发送心跳，服务器在线租约为 6 秒；服务器离线期间禁止发送请求。
- 单次请求等待 20 秒；同一频道最多 16 个待处理请求、累计 2048 个请求。

## 快速开始

需要 Node.js `>=22.12.0` 和 npm。

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:8088`。开发脚本会先构建前端，再启动本地 Workers 运行时；Durable Object 状态保存在 `.wrangler/state`。

## 配置

生产环境必须把 `wrangler.jsonc` 中的 `vars.PUBLIC_ORIGIN` 设置成用户实际访问的站点源，例如：

```jsonc
"vars": {
  "PUBLIC_ORIGIN": "https://webui.example.com"
}
```

只填协议和主机，不加路径或末尾斜线。该值用于校验 HTTP/WebSocket `Origin`、设置安全 Cookie 和生成编辑链接；与浏览器访问地址不一致时请求会被拒绝。

`CHANNELS`、`SESSIONS` 是通过 `wrangler.jsonc` 绑定的 SQLite Durable Objects。不要在部署后删除或重命名这些类，也不要删除已应用的迁移记录。

## 部署

标准部署到 Cloudflare Workers：

```bash
npx wrangler login
npm run deploy
```

如需 EdgeOne CDN 加速（Cloudflare Worker 作源站、EdgeOne 作访问入口），按 [部署方法.md](./部署方法.md) 操作。其中包含 EdgeOne 源站、回源 Host、WebSocket、缓存规则、DNS 切换和验收步骤。

## 测试与构建

```bash
npm test        # Worker 集成测试：真实 workerd 运行时 + SQLite 持久化
npm run build   # TypeScript 检查 + Vite 生产构建
```

测试使用独立的 workerd 进程和持久化目录，覆盖配对、授权、休眠恢复、重连、超时、限流和重启后数据持续性。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 构建并启动本地 Workers 运行时（`127.0.0.1:8088`） |
| `npm run build` | 类型检查并构建前端到 `dist/` |
| `npm run deploy` | 构建后运行 `wrangler deploy` |
| `npm test` | 运行 `src/worker/*.test.ts` |

## 安全说明

- 不要转发完整编辑链接或一次性验证码；打开链接的浏览器才能完成授权。
- 加密密钥、会话 Cookie 和频道凭证不应出现在 Worker 变量、EdgeOne 配置、日志或 Durable Object 数据中。
- `PUBLIC_ORIGIN` 校验用于阻止跨站请求，不能替代边缘防护；不要把 CDN 视为 Worker 源站 URL 的访问控制层。

## 目录结构

```text
src/
  client/     React 界面：会话、加密、配置编辑器、管理面板
  shared/     浏览器与 Worker 共用的协议类型
  server/     服务端消息校验
  worker/     Worker 入口、频道与会话 Durable Objects、通用逻辑、测试
```
