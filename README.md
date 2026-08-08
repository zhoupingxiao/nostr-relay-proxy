# Nostr Relay Proxy + Admin

Cloudflare Workers + Durable Objects 的多上游 Nostr Relay 聚合代理。

## 功能

- WebSocket Nostr Relay：EVENT / REQ / CLOSE
- 多上游 Relay 聚合
- Event 去重
- EOSE 聚合
- 上游自动重连
- NIP-11 Relay 信息
- Web 管理后台
- 上游 Relay 增删、启停
- 在线客户端/订阅/事件统计
- Cloudflare Workers GitHub CI/CD
- 不使用 D1/R2

## 部署到 Cloudflare

1. 将仓库导入 GitHub。
2. Cloudflare Dashboard -> Workers & Pages -> Create -> Import an existing Git repository。
3. Root directory 留空。
4. Build command：`npm install`
5. Deploy command：`npx wrangler deploy`
6. 在 Cloudflare Dashboard 打开该 Worker 的 **Settings -> Variables and Secrets**，手动创建以下绑定：
   - `ADMIN_USER`：管理后台用户名（普通文本变量）
   - `ADMIN_PASSWORD`：管理后台密码（Secret）
   - `UPSTREAM_RELAYS`：可选。首次创建 Durable Object 时导入的上游地址，以英文逗号分隔，例如 `wss://relay.example.com,wss://relay2.example.com`

这些变量不会写入 `wrangler.jsonc`，也不会由 GitHub Actions 覆盖。未同时配置 `ADMIN_USER` 与 `ADMIN_PASSWORD` 时，`/admin` 会拒绝访问，不存在默认账号。

## 自定义域名

Cloudflare Worker 部署后，在 Worker 的 Settings -> Domains & Routes 添加你的域名，例如：

`relay.example.com`

Nostr 客户端连接：

`wss://relay.example.com/`

后台：

`https://relay.example.com/admin`

## 本地开发

```bash
npm install
npx wrangler dev
```

本地运行时也请通过 Wrangler 的本地环境机制提供 `ADMIN_USER`、`ADMIN_PASSWORD` 和可选的 `UPSTREAM_RELAYS`；仓库不会提供默认管理账号或上游地址。

## 上游 Relay 配置

`UPSTREAM_RELAYS` 仅用于初始化一个全新的 Durable Object。初始化完成后，上游列表保存在 Durable Object Storage 中，请在 `/admin` 增删或启停。之后即使修改 Dashboard 中的 `UPSTREAM_RELAYS`，也不会覆盖已有列表。

## GitHub Actions

仓库包含 `.github/workflows/deploy.yml`。

需要 GitHub Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

之后 push 到 main 自动部署。

## 注意

这个项目是 Relay 聚合代理，不长期保存 Event。上游 Relay 通过 outbound WebSocket 连接；客户端 WebSocket 由 Durable Object 管理。
