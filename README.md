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
6. 设置环境变量：
   - `ADMIN_USER`
   - `ADMIN_PASSWORD`
   - `UPSTREAM_RELAYS`

推荐把密码放在 Cloudflare Secret，而不是提交到 GitHub。

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

默认管理账号密码请通过 Cloudflare Secret 或环境变量 设置。wrangler.jsonc 中的示例仅用于本地开发，生产环境必须修改。

## GitHub Actions

仓库包含 `.github/workflows/deploy.yml`。

需要 GitHub Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

之后 push 到 main 自动部署。

## 注意

这个项目是 Relay 聚合代理，不长期保存 Event。上游 Relay 通过 outbound WebSocket 连接；客户端 WebSocket 由 Durable Object 管理。
