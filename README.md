# Nostr Relay Proxy + Admin

Cloudflare Workers + Durable Objects 的多上游 Nostr Relay 聚合代理。

## 功能

- WebSocket Nostr Relay：EVENT / REQ / CLOSE / COUNT / NEG-OPEN / NEG-MSG / NEG-CLOSE
- 多上游 Relay 聚合：发布覆盖全部在线上游；读取可设置优先 Relay，并额外查询两个低延迟上游
- EOSE 聚合
- 上游自动重连
- NIP-11 Relay 信息，并由程序自动声明支持的 Relay NIPs：01、11、42、45、77
- Web 管理后台
- 公开状态首页：在线状态、用户/订阅数、Relay 连接状态与连接时长
- 独立的后台登录页与 8 小时安全会话
- 上游 Relay 增删、启停
- 访问控制：全部、白名单、黑名单（按 Nostr 公钥）
- 在线客户端、客户端活跃订阅、上游活跃订阅、事件与流量统计
- 可调的上游 Relay 列表刷新间隔（60–900 秒）
- 前台、后台和登录页支持中文/English 切换，并记住浏览器选择
- 不使用 D1/R2

## 部署到 Cloudflare

1. 将仓库导入 GitHub。
2. Cloudflare Dashboard -> Workers & Pages -> Create -> Import an existing Git repository。
3. Root directory 留空。
4. Build command：`npm install`
5. Deploy command：`npx wrangler deploy --keep-vars`
6. 在 Cloudflare Dashboard 打开该 Worker 的 **Settings -> Variables and Secrets**，手动创建以下绑定：
   - `ADMIN_USER`：管理后台用户名（普通文本变量）
   - `ADMIN_PASSWORD`：管理后台密码（Secret）
   - `UPSTREAM_RELAYS`：可选。首次创建 Durable Object 时导入的上游地址，以英文逗号分隔，例如 `wss://relay.example.com,wss://relay2.example.com`

这些变量不会写入 `wrangler.jsonc`。项目已启用 `keep_vars`，并且部署命令使用 `--keep-vars`，避免 Wrangler 部署时删除 Dashboard 中的变量。未同时配置 `ADMIN_USER` 与 `ADMIN_PASSWORD` 时，后台无法登录，不存在默认账号。

## 自定义域名

Cloudflare Worker 部署后，在 Worker 的 Settings -> Domains & Routes 添加你的域名，例如：

`relay.example.com`

Nostr 客户端连接：

`wss://relay.example.com/`

后台：

`https://relay.example.com/admin`

NIP-11 中继资料：

`https://relay.example.com/nip11`

或使用客户端标准请求：

`curl -H 'Accept: application/nostr+json' https://relay.example.com/`

公开状态页：

`https://relay.example.com/`

公开状态 JSON（用于监控或自定义面板）：

`https://relay.example.com/status`

## 本地开发

```bash
npm install
npx wrangler dev
```

本地运行时也请通过 Wrangler 的本地环境机制提供 `ADMIN_USER`、`ADMIN_PASSWORD` 和可选的 `UPSTREAM_RELAYS`；仓库不会提供默认管理账号或上游地址。

## 上游 Relay 配置

`UPSTREAM_RELAYS` 仅用于初始化一个全新的 Durable Object。初始化完成后，上游列表保存在 Durable Object Storage 中，请在 `/admin` 增删或启停。之后即使修改 Dashboard 中的 `UPSTREAM_RELAYS`，也不会覆盖已有列表。

后台可选择一个“优先中继”。设置后，所有发布会优先发送到该中继，读取和 `COUNT` 会始终经过它，并额外选择两个延迟最低的在线上游；优先中继离线时自动回退到两个低延迟上游，恢复后自动加入。

## 访问控制

后台“访问控制”可选择三种模式：

- `全部`：所有客户端都可读取和发布。
- `白名单`：仅列表中公钥对应的用户可读取和发布。
- `黑名单`：列表中的公钥不能读取或发布，其他已认证用户可使用。

白名单和黑名单均使用 NIP-42 身份认证验证客户端签名，不能只凭客户端自报公钥。后台名单每行格式为“公钥 | 用户名”，用户名仅用于后台识别；公钥可填 64 位十六进制或 `npub1...`，保存时会去重并转换为十六进制。启用这两种模式后，不支持 NIP-42 的客户端无法使用该代理。

## 订阅统计口径

- `客户端活跃订阅`：当前客户端连接发起并仍未关闭的 `REQ` 数量。
- `上游活跃订阅`：代理实际转发到上游 Relay、并仍在路由表中的订阅数量。一个客户端订阅会按在线上游 Relay 展开；相同 Event ID 在代理内去重，只会向客户端发送一次。

## 免费额度与请求控制

上游 Relay 列表会按后台保存的间隔自动刷新，默认 60 秒、可设为 60–900 秒；手机页面会同步更新为紧凑卡片布局。后台已移除“最近流量”明细，不再保存最近消息摘要，只保留汇总统计。

代码内置以下保护，优先降低 Durable Objects 请求：

- 流量与连接统计最多约每 30 秒写入一次 Durable Object Storage；并发写入会自动合并，避免高流量时堆积存储请求。
- 客户端发起 NIP-45 `COUNT` 时优先转发到优先中继，再加最多 2 个低延迟上游，避免大量上游同时放大查询。
- 普通 `REQ` 每个订阅优先查询优先中继，再加最多 2 个延迟较低的在线上游；其他上游仍用于发布与故障切换。这样会降低对第三个及以后上游独有历史事件的覆盖率。
- 每个客户端最多 24 个活跃订阅、每个订阅最多 20 个 filter，且请求体最大 48 KiB；超出时返回 `rate-limited`。
- 新建 WebSocket 连接会按 IP 限制为每分钟 12 次，在请求进入 Durable Object 前拒绝异常重连或扫描流量。
- 公开状态缓存 60 秒，NIP-11 资料缓存 5 分钟；保存中继资料或修改上游时会立即清除缓存。
- 自动刷新间隔最低为 60 秒，与公开状态缓存一致；管理后台打开时才会按该间隔请求状态，关闭页面后不会继续请求。
- 上游断线会继续自动重连，但采用带随机抖动的指数退避：约 2、4、8 秒逐步增加，最长约 15 分钟；稳定连接至少 30 秒后才恢复较短的重试间隔。无法连接的中继不会占用客户端在线连接，但每次重试都会产生一次出站连接尝试，长期失效的中继建议在后台停用或删除。
- 上游启动采用排队连接，最多同时建立 8 个 WebSocket；大量 Relay 不会在 Worker 或本地 Wrangler 启动时瞬间并发连接。
- 重连时间同时登记到 Durable Object Alarm；即使对象因空闲被回收，Alarm 也会按保存的退避时间恢复失联中继，不依赖手动重启。

Durable Object 会在请求进入时自动迁移旧版本的运行状态（例如访问控制字段和旧客户端连接字段），不需要单独的“重启”按钮。部署新版本后，首次访问会完成迁移并继续使用原有 Relay 列表与设置。

## Nostr 协议支持

后台不会提供 NIPs 输入框。`supported_nips` 由程序自动生成，避免手动声明未实现的能力：

`01, 11, 42, 45, 77`

后台“机主公钥”可输入 64 位十六进制公钥或 `npub1...`；保存时会自动转换为 NIP-11 要求的 64 位十六进制格式。

- `01`：WebSocket 基础 Relay 消息（`EVENT / REQ / CLOSE / EOSE / NOTICE / OK / CLOSED`）与多上游事件合并去重。
- `11`：对客户端标准的 NIP-11 请求返回后台配置的中继名称、描述、机主公钥、头像、联系方式与支持的 NIPs。
- `42`：在白名单或黑名单模式下，使用标准 `AUTH` 挑战和签名事件认证客户端公钥。
- `45`：支持客户端 `COUNT` 请求，并聚合上游 Relay 返回的计数；如果上游返回 `hll`，会合并 HyperLogLog 寄存器。多个上游可能存在重复事件，所以结果会标记为近似值。
- `77`：支持 Negentropy 会话消息的上游路由，当前会选择一个在线上游 Relay 透传 `NEG-OPEN / NEG-MSG / NEG-CLOSE`。

`02 / 04 / 09 / 28 / 40` 是事件格式或事件语义。代理会透明转发这些事件，但它们不是由本代理独立实现和存储的 Relay 功能，因此不会写进 `supported_nips`。NIP-70 的受保护事件需要 NIP-42 认证；本代理会按规范拒绝它们，也不会宣称支持 NIP-70。

## GitHub Actions

仓库包含 `.github/workflows/deploy.yml`，但已关闭 push 自动部署；需要时可在 GitHub Actions 手动运行 workflow。

需要 GitHub Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

手动运行 workflow 后会使用 `npx wrangler deploy --keep-vars` 部署到 Cloudflare。也可以在本地运行 `npm run deploy`。

## 注意

这个项目是 Relay 聚合代理，不长期保存 Event。上游 Relay 通过 outbound WebSocket 连接；客户端 WebSocket 由 Durable Object 管理。

## 本地检查

```bash
npm test
npx wrangler deploy --dry-run
```

`npm test` 会检查健康接口、管理员变量缺失时的安全失败、设置规范化和无上游时的订阅关闭行为；不会连接真实上游 Relay。
