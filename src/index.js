import { verifyEvent } from "nostr-tools/pure";

function configuredRelays(env) {
  // This binding is configured in the Cloudflare dashboard. It seeds only a
  // brand-new Durable Object; subsequent changes belong in the admin UI.
  return (typeof env.UPSTREAM_RELAYS === "string" ? env.UPSTREAM_RELAYS : "")
    .split(",")
    .map(s => normalizeRelayUrl(s))
    .filter(isRelayUrl)
    .map(url => relayState(url));
}

function relayState(url, extra = {}) {
  return {
    url,
    enabled: true,
    connected: false,
    reconnects: 0,
    reconnectDelayMs: 1000,
    nextReconnectAt: null,
    lastError: null,
    lastConnectedAt: null,
    forwardedEvents: 0,
    downloadedEvents: 0,
    uploadedBytes: 0,
    downloadedBytes: 0,
    uploadedMessages: 0,
    downloadedMessages: 0,
    latencyMs: null,
    lastLatencyAt: null,
    ...extra
  };
}

// Only advertise relay-side protocol features implemented by this proxy.
// Event-format NIPs (such as 2, 4, 9, 28 and 40) are transparently forwarded
// to upstream relays but are not features implemented by this relay itself.
const DEFAULT_SUPPORTED_NIPS = [1, 11, 42, 45, 77];
const DEFAULT_PERSIST_INTERVAL_MS = 30000;
const DEFAULT_MAX_SECONDARY_RELAYS = 2;
const DEFAULT_MAX_CLIENT_SUBSCRIPTIONS = 24;
const DEFAULT_MAX_FILTERS_PER_SUBSCRIPTION = 20;
const DEFAULT_MAX_SUBSCRIPTION_BYTES = 48 * 1024;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 15 * 60 * 1000;
const PUBLIC_STATUS_CACHE_SECONDS = 60;
const NIP11_CACHE_SECONDS = 300;
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function normalizeRelayUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^wss:\/\//i.test(raw)) return `wss://${raw.slice(6)}`;
  if (/^ws:\/\//i.test(raw)) return `ws://${raw.slice(5)}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  return `wss://${raw}`;
}

function isRelayUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:") &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

function bech32Polymod(values) {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    if (top & 1) check ^= 0x3b6a57b2;
    if (top & 2) check ^= 0x26508e6d;
    if (top & 4) check ^= 0x1ea119fa;
    if (top & 8) check ^= 0x3d4233dd;
    if (top & 16) check ^= 0x2a1462b3;
  }
  return check >>> 0;
}

function decodeNpub(value) {
  const input = String(value || "").trim();
  if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase();
  if (!input || (input !== input.toLowerCase() && input !== input.toUpperCase())) return "";
  const bech32 = input.toLowerCase();
  const separator = bech32.lastIndexOf("1");
  if (bech32.slice(0, separator) !== "npub" || separator < 1 || separator + 7 > bech32.length) return "";
  const values = [...bech32.slice(separator + 1)].map(char => BECH32_CHARSET.indexOf(char));
  if (values.some(value => value < 0)) return "";
  const expanded = [..."npub"].map(char => char.charCodeAt(0) >> 5)
    .concat(0, [..."npub"].map(char => char.charCodeAt(0) & 31), values);
  if (bech32Polymod(expanded) !== 1) return "";
  const payload = values.slice(0, -6);
  const bytes = [];
  let accumulator = 0;
  let bits = 0;
  for (const part of payload) {
    accumulator = (accumulator << 5) | part;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 255);
    }
  }
  if (bits >= 5 || ((accumulator << (8 - bits)) & 255) || bytes.length !== 32) return "";
  return bytes.map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

function errorMessage(error) {
  return error?.message ? String(error.message) : String(error || "unknown error");
}

function nip11Headers(extra = {}) {
  return {
    "content-type": "application/nostr+json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "accept, content-type",
    "access-control-allow-methods": "GET, OPTIONS",
    "cache-control": "no-store",
    ...extra
  };
}

function publicCacheKey(url, name) {
  const key = new URL(url.origin);
  key.pathname = `/_relay-cache/${name}`;
  return new Request(key.toString());
}

async function cachedRelayResponse(request, env, upstreamPath, cacheName, seconds) {
  const cache = caches.default;
  const key = publicCacheKey(new URL(request.url), cacheName);
  const cached = await cache.match(key);
  if (cached) return cached;
  const id = env.RELAY.idFromName("global");
  const upstream = await env.RELAY.get(id).fetch(`https://relay${upstreamPath}`);
  const headers = new Headers(upstream.headers);
  headers.set("cache-control", `public, max-age=${seconds}, s-maxage=${seconds}`);
  const response = new Response(upstream.body, { status: upstream.status, headers });
  await cache.put(key, response.clone());
  return response;
}

async function clearPublicRelayCache(request) {
  const cache = caches.default;
  const url = new URL(request.url);
  await Promise.all([
    cache.delete(publicCacheKey(url, "status")),
    cache.delete(publicCacheKey(url, "nip11"))
  ]);
}

async function allowWebSocketConnection(request, env) {
  if (!env.CONNECTION_LIMIT) return true;
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown";
  try {
    return (await env.CONNECTION_LIMIT.limit({ key: ip })).success;
  } catch {
    // A rate-limiter availability issue must not take the relay offline.
    return true;
  }
}

async function authOk(request, env) {
  const username = typeof env.ADMIN_USER === "string" ? env.ADMIN_USER : "";
  const password = typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";
  // A deployment must not inherit a usable default administrator account.
  if (!username || !password) return false;

  const session = readCookie(request, "relay_admin");
  if (session && await verifySession(session, username, password)) return true;

  const h = request.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  try {
    const decoded = atob(h.slice(6));
    const i = decoded.indexOf(":");
    if (i < 0) return false;
    return decoded.slice(0, i) === username && decoded.slice(i + 1) === password;
  } catch { return false; }
}

function readCookie(request, name) {
  const value = request.headers.get("cookie") || "";
  const found = value.split(";").map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : "";
}

function base64url(bytes) {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlBytes(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

async function sessionSignature(payload, password) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
}

async function createSession(username, password) {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ u: username, exp: Date.now() + 8 * 60 * 60 * 1000 })));
  return `${payload}.${await sessionSignature(payload, password)}`;
}

async function verifySession(token, username, password) {
  try {
    const [payload, signature] = token.split(".");
    if (!payload || !signature || signature !== await sessionSignature(payload, password)) return false;
    const data = JSON.parse(new TextDecoder().decode(base64urlBytes(payload)));
    return data.u === username && Number(data.exp) > Date.now();
  } catch { return false; }
}

function loginPage(error = "") {
  return new Response(LOGIN_HTML.replace("__ERROR__", error), { headers: { "content-type": "text/html; charset=utf-8" } });
}

function sessionCookie(request, value, maxAge) {
  // Local Wrangler development uses HTTP; production Cloudflare traffic is HTTPS.
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `relay_admin=${encodeURIComponent(value)}; Path=/admin; HttpOnly${secure}; SameSite=Strict; Max-Age=${maxAge}`;
}

function unauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Nostr Relay Admin"' }
  });
}

function relayUrl(request) {
  const u = new URL(request.url);
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}${u.pathname}`;
}

function byteLength(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function trafficSummary(direction, source, raw, msg) {
  const type = Array.isArray(msg) ? String(msg[0] || "UNKNOWN") : "UNKNOWN";
  const item = {
    at: Date.now(),
    direction,
    source,
    type,
    bytes: byteLength(raw)
  };
  if (type === "EVENT") {
    const event = direction === "upload" ? msg?.[1] : msg?.[2];
    item.eventId = event?.id || null;
    item.kind = Number.isFinite(event?.kind) ? event.kind : null;
    if (direction === "download") item.subscription = String(msg?.[1] || "");
  } else if (type === "REQ" || type === "COUNT" || type === "NEG-OPEN") {
    item.subscription = String(msg?.[1] || "");
    item.filters = Math.max(0, msg.length - 2);
  } else if (type === "CLOSE" || type === "EOSE" || type === "CLOSED" || type === "NEG-MSG" || type === "NEG-CLOSE" || type === "NEG-ERR") {
    item.subscription = String(msg?.[1] || "");
  } else if (type === "OK") {
    item.eventId = String(msg?.[1] || "");
    item.ok = msg?.[2] === true;
  }
  return item;
}

function defaultSettings(env = {}) {
  return {
    name: typeof env.RELAY_NAME === "string" ? env.RELAY_NAME : "Nostr Relay Proxy",
    description: typeof env.RELAY_DESCRIPTION === "string" ? env.RELAY_DESCRIPTION : "Multi-relay Nostr aggregation proxy",
    pubkey: decodeNpub(env.RELAY_PUBKEY),
    contact: typeof env.RELAY_CONTACT === "string" ? env.RELAY_CONTACT : "",
    icon: typeof env.RELAY_ICON === "string" ? env.RELAY_ICON : "",
    software: "https://github.com/zhoupingxiao/nostr-relay-proxy",
    version: "1.0.0",
    priorityRelay: "",
    statusRefreshSeconds: 60,
    accessMode: "all",
    accessPubkeys: [],
    accessUsers: [],
    supported_nips: DEFAULT_SUPPORTED_NIPS
  };
}

function statusRefreshSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 60;
  return Math.min(900, Math.max(60, Math.round(seconds)));
}

function accessMode(value) {
  return ["all", "whitelist", "blacklist"].includes(value) ? value : "all";
}

function accessUserInputs(value) {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === "string") {
        const separator = item.indexOf("|");
        return separator < 0
          ? { pubkey: item.trim(), name: "" }
          : { pubkey: item.slice(0, separator).trim(), name: item.slice(separator + 1).trim() };
      }
      return { pubkey: String(item?.pubkey || "").trim(), name: String(item?.name || "").trim() };
    }).filter(item => item.pubkey || item.name);
  }
  return String(value || "").split(/\r?\n/).map(line => {
    const separator = line.indexOf("|");
    return separator < 0
      ? { pubkey: line.trim(), name: "" }
      : { pubkey: line.slice(0, separator).trim(), name: line.slice(separator + 1).trim() };
  }).filter(item => item.pubkey || item.name);
}

function accessUsers(value) {
  const seen = new Set();
  return accessUserInputs(value).map(item => {
    const pubkey = decodeNpub(item.pubkey);
    if (!pubkey || seen.has(pubkey)) return null;
    seen.add(pubkey);
    return { pubkey, name: item.name.slice(0, 120) };
  }).filter(Boolean).slice(0, 500);
}

function relayHost(value) {
  try { return new URL(value).host.toLowerCase(); } catch { return ""; }
}

  function reconnectDelayMs(current = 1000) {
  const next = Math.min(DEFAULT_MAX_RECONNECT_DELAY_MS, Math.max(1000, Number(current) * 2));
  return Math.max(1000, Math.round(next * (0.8 + Math.random() * 0.4)));
}

function mergeHll(a, b) {
  if (!/^[0-9a-f]{512}$/i.test(String(b || ""))) return a;
  if (!a) return String(b).toLowerCase();
  const left = a.match(/../g) || [];
  const right = String(b).toLowerCase().match(/../g) || [];
  if (left.length !== 256 || right.length !== 256) return a;
  return left.map((x, i) => Math.max(parseInt(x, 16), parseInt(right[i], 16)).toString(16).padStart(2, "0")).join("");
}

function normalizeSettings(input, env) {
  const base = defaultSettings(env);
  const rawAccessUsers = input && Object.prototype.hasOwnProperty.call(input, "accessUsers")
    ? input.accessUsers
    : input?.accessPubkeys;
  const normalizedAccessUsers = accessUsers(rawAccessUsers);
  return {
    name: String(input?.name || base.name).trim() || base.name,
    description: String(input?.description || "").trim() || base.description,
    pubkey: decodeNpub(input?.pubkey),
    contact: String(input?.contact || "").trim(),
    icon: String(input?.icon || "").trim(),
    software: String(input?.software || base.software).trim() || base.software,
    version: String(input?.version || base.version).trim() || base.version,
    priorityRelay: isRelayUrl(normalizeRelayUrl(input?.priorityRelay)) ? normalizeRelayUrl(input?.priorityRelay) : "",
    statusRefreshSeconds: statusRefreshSeconds(input?.statusRefreshSeconds),
    accessMode: accessMode(input?.accessMode),
    accessPubkeys: normalizedAccessUsers.map(item => item.pubkey),
    accessUsers: normalizedAccessUsers,
    supported_nips: DEFAULT_SUPPORTED_NIPS
  };
}

function nip11Info(settings) {
  // This is generated by the implementation rather than configurable metadata,
  // so clients never receive a capability claim that the proxy cannot honour.
  const { accessMode, accessPubkeys, accessUsers, ...publicSettings } = settings;
  return {
    ...publicSettings,
    supported_nips: DEFAULT_SUPPORTED_NIPS
  };
}

function publicStatusSettings(settings) {
  const { accessMode, accessPubkeys, accessUsers, ...publicSettings } = settings;
  return publicSettings;
}

function adminPage() {
  return new Response(renderAdminHtml(), {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function renderAdminHtml() {
  const mobileTableStyle = `<style>@media(min-width:901px){.relay-admin-grid{grid-template-columns:minmax(0,2fr) minmax(420px,1fr)}}.access-user-row{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(90px,1fr) auto;gap:6px}.relay-panel .table th:first-child,.relay-panel .table td:first-child{width:1%;min-width:0!important;white-space:nowrap}@media(max-width:720px){.access-user-row{grid-template-columns:1fr}.relay-panel,.relay-panel .table-wrap{min-width:0}.relay-panel .table-wrap{max-width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}.relay-panel .table{display:table;width:max-content;min-width:100%}.relay-panel .table thead{display:table-header-group}.relay-panel .table tbody{display:table-row-group}.relay-panel .table tr{display:table-row;margin:0;padding:0;border:0;background:transparent}.relay-panel .table th,.relay-panel .table td{display:table-cell;width:1%;min-width:auto!important;white-space:nowrap!important;padding:8px 7px;border-bottom:1px solid #222b37;text-align:left;word-break:normal}.relay-panel .table td::before{display:none}}</style>`;
  const refreshScript = `<script>(()=>{let timer;const input=()=>document.getElementById('set-status-refresh');const seconds=()=>Math.min(900,Math.max(60,Number(input()?.value)||60));const schedule=()=>{clearTimeout(timer);timer=setTimeout(async()=>{await refresh();schedule()},seconds()*1000)};const setIfIdle=(id,value)=>{const el=document.getElementById(id);if(el&&document.activeElement!==el)el.value=value};const sync=()=>{const saved=window.fillSettings;window.fillSettings=(settings,...args)=>{saved(settings,...args);if(input()&&settings&&document.activeElement!==input()){input().value=settings.statusRefreshSeconds||60;schedule()}if(settings){setIfIdle('set-access-mode',settings.accessMode||'all');setIfIdle('set-access-pubkeys',(settings.accessPubkeys||[]).join('\n'))}};const priority=window.fillPriorityRelay;window.fillPriorityRelay=(...args)=>{if(document.activeElement?.id==='set-priority-relay')return;priority(...args)};setTimeout(schedule,50)};sync();document.getElementById('save-settings').addEventListener('click',()=>setTimeout(schedule,2500));})()</script>`;
  const adminRefreshScript = `<script>(()=>{let timer;const input=()=>document.getElementById('set-status-refresh');const seconds=()=>Math.min(900,Math.max(60,Number(input()?.value)||60));const schedule=()=>{clearTimeout(timer);timer=setTimeout(async()=>{await refresh();schedule()},seconds()*1000)};const setIfIdle=(id,value)=>{const el=document.getElementById(id);if(el&&document.activeElement!==el)el.value=value};const sync=()=>{const saved=window.fillSettings;window.fillSettings=(settings,...args)=>{saved(settings,...args);if(input()&&settings&&document.activeElement!==input()){input().value=settings.statusRefreshSeconds||60;schedule()}if(settings){setIfIdle('set-access-mode',settings.accessMode||'all');setIfIdle('set-access-pubkeys',(settings.accessPubkeys||[]).join(String.fromCharCode(10)))}};const priority=window.fillPriorityRelay;window.fillPriorityRelay=(...args)=>{if(document.activeElement?.id==='set-priority-relay')return;priority(...args)};setTimeout(schedule,50)};sync();document.getElementById('save-settings').addEventListener('click',()=>setTimeout(schedule,2500));})()</script>`;
  const activeUsersScript = `<script>(()=>{window.renderAccessUsers=status=>{const list=document.getElementById('active-users');const detail=document.getElementById('active-users-detail');if(!list||!detail)return;const mode=status.settings?.accessMode||'all';const users=status.activeUsers||[];if(mode==='all'){detail.textContent='全部模式按在线连接计数；客户端未认证时无法识别其公钥。';list.replaceChildren();return}detail.textContent='当前 '+users.length+' 个已认证且通过规则的用户；已认证公钥总数 '+(status.authenticatedUsers??0)+'。';list.replaceChildren(...users.map(pubkey=>{const row=document.createElement('div');row.className='relay';const name=document.createElement('div');name.className='relay-name';name.textContent=pubkey.slice(0,16)+'…'+pubkey.slice(-10);name.title=pubkey;const copy=document.createElement('button');copy.className='copy';copy.textContent='复制';copy.onclick=async()=>{await navigator.clipboard.writeText(pubkey);copy.textContent='已复制'};row.append(name,copy);return row}));if(!users.length)list.innerHTML='<div class="muted">暂无有效用户</div>'}})()</script>`;
  const activeUsersNamesScript = `<script>(()=>{window.renderAccessUsers=status=>{const list=document.getElementById('active-users');const detail=document.getElementById('active-users-detail');if(!list||!detail)return;const mode=status.settings?.accessMode||'all';const users=status.activeUsers||[];if(mode==='all'){detail.textContent='全部模式按在线连接计数；客户端未认证时无法识别其公钥。';list.replaceChildren();return}detail.textContent='当前 '+users.length+' 个已认证且通过规则的用户；已认证公钥总数 '+(status.authenticatedUsers??0)+'。';list.replaceChildren(...users.map(user=>{const pubkey=user.pubkey||'';const row=document.createElement('div');row.className='relay';const name=document.createElement('div');name.className='relay-name';name.textContent=(user.name?user.name+' · ':'')+pubkey.slice(0,16)+'…'+pubkey.slice(-10);name.title=pubkey;const copy=document.createElement('button');copy.className='copy';copy.textContent='复制';copy.onclick=async()=>{await navigator.clipboard.writeText(pubkey);copy.textContent='已复制'};row.append(name,copy);return row}));if(!users.length)list.innerHTML='<div class="muted">暂无有效用户</div>'}})()</script>`;
  const namedAccessSettingsScript = `<script>(()=>{const saved=window.fillSettings;window.fillSettings=(settings,...args)=>{saved(settings,...args);const el=document.getElementById('set-access-users');if(el&&settings&&document.activeElement!==el)el.value=(settings.accessUsers||[]).map(user=>user.pubkey+(user.name?' | '+user.name:'')).join(String.fromCharCode(10))}})()</script>`;
  const accessUsersFormScript = `<script>(()=>{const root=()=>document.getElementById('set-access-users');const add=(user={})=>{const container=root();if(!container)return;const row=document.createElement('div');row.className='access-user-row';const pubkey=document.createElement('input');pubkey.className='input';pubkey.dataset.field='pubkey';pubkey.placeholder='公钥（npub 或 hex）';pubkey.value=user.pubkey||'';const name=document.createElement('input');name.className='input';name.dataset.field='name';name.placeholder='用户名';name.value=user.name||'';const remove=document.createElement('button');remove.type='button';remove.className='button danger mini';remove.textContent='删除';remove.onclick=()=>row.remove();row.append(pubkey,name,remove);container.append(row)};window.renderAccessUsersForm=users=>{const container=root();if(!container||document.activeElement?.closest('.access-user-row'))return;container.replaceChildren();for(const user of users||[])add(user);if(!container.children.length)add()};window.collectAccessUsers=()=>[...root()?.querySelectorAll('.access-user-row')||[]].map(row=>{const pubkey=row.querySelector('[data-field=pubkey]')?.value.trim()||'';const name=row.querySelector('[data-field=name]')?.value.trim()||'';return pubkey?(pubkey+(name?' | '+name:'')):''}).filter(Boolean).join(String.fromCharCode(10));document.getElementById('add-access-user')?.addEventListener('click',()=>add()) ;const saved=window.fillSettings;window.fillSettings=(settings,...args)=>{saved(settings,...args);if(settings)window.renderAccessUsersForm(settings.accessUsers||[])}})()</script>`;
  const safeAdminRefreshScript = adminRefreshScript.replaceAll('set-access-pubkeys', 'set-access-users').replaceAll('accessPubkeys||[]).join(String.fromCharCode(10))', "accessUsers||[]).map(user=>user.pubkey+(user.name?' | '+user.name:'')).join(String.fromCharCode(10))");
  return ADMIN_HTML
    .replace('打开页面时读取一次连接、流量与上游健康状态；需要最新数据时请手动刷新浏览器页面。', '上游 Relay 列表会按设定间隔刷新；其余资料在打开页面或保存设置时更新。')
    .replace('支持的 NIPs（由程序自动声明）：01、11、45、77', '支持的 NIPs（由程序自动声明）：01、11、42、45、77')
    .replace('<select class="input" id="set-priority-relay"><option value="">不设置（仅按延迟）</option></select><button class="button primary" id="save-settings">保存资料和优先中继</button>', '<select class="input" id="set-priority-relay"><option value="">不设置（仅按延迟）</option></select><label class="muted" for="set-status-refresh">上游列表刷新间隔（秒，最低 60）</label><input class="input" id="set-status-refresh" type="number" min="60" max="900" step="30" value="60"><button class="button primary" id="save-settings">保存资料和运行设置</button>')
    .replace('<input class="input" id="set-status-refresh" type="number" min="60" max="900" step="30" value="60"><button class="button primary" id="save-settings">保存资料和运行设置</button>', '<input class="input" id="set-status-refresh" type="number" min="60" max="900" step="30" value="60"><hr style="border:0;border-top:1px solid #28445f;margin:8px 0 2px;width:100%"><h2>访问控制</h2><p class="muted" style="margin:0">白名单和黑名单会要求客户端完成 NIP-42 身份认证；每行填入一个用户公钥（hex 或 npub）。</p><select class="input" id="set-access-mode"><option value="all">全部</option><option value="whitelist">白名单</option><option value="blacklist">黑名单</option></select><textarea class="input" id="set-access-pubkeys" rows="8" wrap="off" style="min-width:0;white-space:pre;overflow-x:auto" placeholder="npub1… 或 64 位 hex 公钥，每行一个"></textarea><button class="button primary" id="save-settings">保存资料和运行设置</button>')
    .replace('每行填入一个用户公钥（hex 或 npub）。', '每行一条，格式为：公钥 | 用户名（用户名可选）。')
    .replace('npub1… 或 64 位 hex 公钥，每行一个', 'npub1… 或 64 位 hex 公钥 | 用户名，每行一条')
    .replace('<textarea class="input" id="set-access-pubkeys" rows="8" wrap="off" style="min-width:0;white-space:pre;overflow-x:auto" placeholder="npub1… 或 64 位 hex 公钥 | 用户名，每行一条"></textarea>', '<div class="access-user-list" id="set-access-pubkeys"></div><button class="button mini" type="button" id="add-access-user">新增用户</button>')
    .replace('</aside>', '<hr style="border:0;border-top:1px solid #28445f;margin:22px 0"><h2>当前有效用户</h2><p class="muted" id="active-users-detail">加载中…</p><div class="relay-list" id="active-users"></div></aside>')
    .replace("const s=await api('/admin/api/status');", "const s=await api('/admin/api/status');window.renderAccessUsers?.(s);")
    .replace("card('在线用户',s.clients),", "card(s.settings?.accessMode==='all'?'在线连接':'有效用户',s.clients),card('已认证用户',s.authenticatedUsers??0),")
    .replace('accessPubkeys:document.getElementById(\'set-access-pubkeys\').value', 'accessUsers:document.getElementById(\'set-access-users\').value')
    .replaceAll('set-access-pubkeys', 'set-access-users')
    .replace("(settings.accessPubkeys||[]).join(String.fromCharCode(10))", "(settings.accessUsers||[]).map(user=>user.pubkey+(user.name?' | '+user.name:'')).join(String.fromCharCode(10))")
    .replace('priorityRelay:document.getElementById(\'set-priority-relay\').value})', 'priorityRelay:document.getElementById(\'set-priority-relay\').value,statusRefreshSeconds:document.getElementById(\'set-status-refresh\').value,accessMode:document.getElementById(\'set-access-mode\').value,accessUsers:window.collectAccessUsers()})')
    .replace('已保存中继资料和优先中继', '已保存中继资料、优先中继、刷新间隔和访问控制')
    .replaceAll('保存资料和优先中继', '保存资料和运行设置')
    .replace('</head>', `${mobileTableStyle}</head>`)
    .replace('</body>', `${activeUsersScript}${activeUsersNamesScript}${accessUsersFormScript}${namedAccessSettingsScript}${safeAdminRefreshScript}</body>`);
}

function renderHomeHtml() {
  return HOME_HTML.replace(
    "metric('在线用户',s.clients)",
    "metric('有效用户',s.clients)"
  ).replace(
    '页面只在打开或手动刷新浏览器时读取一次状态，尽量节省 Cloudflare 免费额度。',
    '上游 Relay 列表会按后台设定的安全间隔自动更新，兼顾状态及时性与 Cloudflare 免费额度。'
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: nip11Headers() });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "nostr-relay-proxy", time: Date.now() });
    }

    if (url.pathname === "/") {
      // Nostr clients connect to the root URL with a WebSocket upgrade. This
      // must be handled before returning the human-facing homepage.
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        if (!await allowWebSocketConnection(request, env))
          return new Response("Too many new WebSocket connections; please retry shortly.", { status: 429 });
        const id = env.RELAY.idFromName("global");
        return env.RELAY.get(id).fetch(request);
      }
      if (request.headers.get("accept")?.includes("application/nostr+json")) {
        return cachedRelayResponse(request, env, "/nip11", "nip11", NIP11_CACHE_SECONDS);
      }
      if (request.headers.get("accept")?.includes("application/json")) {
        return json({ name: "nostr-relay-proxy", websocket: relayUrl(request), status: `${url.origin}/status`, admin: `${url.origin}/admin` });
      }
      return new Response(renderHomeHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/status") {
      return cachedRelayResponse(request, env, "/public-status", "status", PUBLIC_STATUS_CACHE_SECONDS);
    }

    if (url.pathname === "/nip11") {
      return cachedRelayResponse(request, env, "/nip11", "nip11", NIP11_CACHE_SECONDS);
    }

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (url.pathname === "/admin/api/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const username = typeof env.ADMIN_USER === "string" ? env.ADMIN_USER : "";
        const password = typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";
        if (!username || !password) {
          return json({ error: "当前 Worker 未读取到 ADMIN_USER 或 ADMIN_PASSWORD，请在 Variables and Secrets 保存并部署到当前环境。" }, 503);
        }
        if (body.username !== username || body.password !== password) return json({ error: "用户名或密码错误" }, 401);
        const session = await createSession(username, password);
        return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, session, 28800) });
      }
      if (url.pathname === "/admin/api/logout" && request.method === "POST")
        return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0) });
      if (!await authOk(request, env)) {
        if (url.pathname === "/admin") return loginPage();
        return unauthorized();
      }
      if (url.pathname === "/admin") return adminPage();

      const id = env.RELAY.idFromName("global");
      const stub = env.RELAY.get(id);

      if (request.method === "GET" && url.pathname === "/admin/api/status")
        return stub.fetch("https://relay/status");

      if (request.method === "GET" && url.pathname === "/admin/api/relays")
        return stub.fetch("https://relay/relays");

      if (request.method === "GET" && url.pathname === "/admin/api/settings")
        return stub.fetch("https://relay/settings");

      if (request.method === "POST" && url.pathname === "/admin/api/settings") {
        const response = await stub.fetch(new Request("https://relay/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text()
        }));
        if (response.ok) await clearPublicRelayCache(request);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/admin/api/relays") {
        const response = await stub.fetch(new Request("https://relay/relays", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text()
        }));
        if (response.ok) await clearPublicRelayCache(request);
        return response;
      }

      if (request.method === "DELETE" && url.pathname === "/admin/api/relays") {
        const response = await stub.fetch(new Request("https://relay/relays", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: await request.text()
        }));
        if (response.ok) await clearPublicRelayCache(request);
        return response;
      }

      if (request.method === "POST" && url.pathname === "/admin/api/relays/toggle") {
        const response = await stub.fetch(new Request("https://relay/relays/toggle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text()
        }));
        if (response.ok) await clearPublicRelayCache(request);
        return response;
      }

      return json({ error: "not found" }, 404);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (!await allowWebSocketConnection(request, env))
        return new Response("Too many new WebSocket connections; please retry shortly.", { status: 429 });
      const id = env.RELAY.idFromName("global");
      return env.RELAY.get(id).fetch(request);
    }

    if (request.headers.get("accept")?.includes("application/nostr+json")) {
      const id = env.RELAY.idFromName("global");
      return env.RELAY.get(id).fetch("https://relay/nip11");
    }

    return json({ error: "not found" }, 404);
  }
};

export class RelayHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map();
    this.upstreams = new Map();
    this.relays = [];
    this.settings = defaultSettings(env);
    this.stats = {
      events: 0, forwarded: 0, deduped: 0, connections: 0, reconnects: 0,
      uploadedMessages: 0, downloadedMessages: 0, uploadedBytes: 0, downloadedBytes: 0
    };
    this.lastPersistAt = 0;
    this.persistInFlight = null;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.relays = (await this.state.storage.get("relays") || configuredRelays(this.env))
      .map(r => relayState(r.url, r));
    this.settings = normalizeSettings(await this.state.storage.get("settings"), this.env);
    this.stats = { ...this.stats, ...(await this.state.storage.get("stats") || {}) };
    // These were shown by an older dashboard but are not useful operational
    // metrics for a relay administrator.  Drop historical values as well.
    delete this.stats.errors;
    delete this.stats.lastError;
    if (!this.stats.startedAt) {
      this.stats.startedAt = Date.now();
      await this.state.storage.put("stats", this.stats);
    }
    this.loaded = true;
    for (const r of this.relays.filter(x => x.enabled)) this.connectUpstream(r.url);
  }

  persist() {
    if (this.persistInFlight) return this.persistInFlight;
    this.persistInFlight = (async () => {
      await this.state.storage.put("relays", this.relays);
      await this.state.storage.put("settings", this.settings);
      await this.state.storage.put("stats", this.stats);
      this.lastPersistAt = Date.now();
    })().finally(() => {
      this.persistInFlight = null;
    });
    return this.persistInFlight;
  }

  recordTraffic(direction, source, raw, msg) {
    const entry = trafficSummary(direction, source, raw, msg);
    const relay = direction === "download" ? this.relays.find(r => r.url === source) : null;
    if (direction === "upload") {
      this.stats.uploadedMessages++;
      this.stats.uploadedBytes += entry.bytes;
    } else {
      this.stats.downloadedMessages++;
      this.stats.downloadedBytes += entry.bytes;
      if (relay) {
        relay.downloadedMessages = (relay.downloadedMessages || 0) + 1;
        relay.downloadedBytes = (relay.downloadedBytes || 0) + entry.bytes;
        if (entry.type === "EVENT") relay.downloadedEvents = (relay.downloadedEvents || 0) + 1;
      }
    }
    if (Date.now() - this.lastPersistAt > DEFAULT_PERSIST_INTERVAL_MS) this.persist().catch(() => {});
  }

  ensureRuntimeSettings() {
    if (!this.settings || !["all", "whitelist", "blacklist"].includes(this.settings.accessMode) || !Array.isArray(this.settings.accessPubkeys) || !Array.isArray(this.settings.accessUsers))
      this.settings = normalizeSettings(this.settings, this.env);
  }

  ensureClientState(client) {
    if (!(client.subscriptions instanceof Map)) client.subscriptions = new Map();
    if (!(client.counts instanceof Map)) client.counts = new Map();
    if (!(client.negentropy instanceof Map)) client.negentropy = new Map();
    if (!(client.seen instanceof Map)) client.seen = new Map();
    if (!(client.authenticatedPubkeys instanceof Set)) client.authenticatedPubkeys = new Set();
    if (!client.authChallenge) client.authChallenge = crypto.randomUUID();
    if (!client.relayHost) client.relayHost = "";
    if (typeof client.authChallengeSent !== "boolean") client.authChallengeSent = false;
    return client;
  }

  clientStatistics() {
    this.ensureRuntimeSettings();
    const authenticatedPubkeys = new Set();
    const activePubkeys = new Set();
    let authorizedConnections = 0;
    for (const client of this.clients.values()) {
      this.ensureClientState(client);
      if (this.settings.accessMode !== "all" && !client.authenticatedPubkeys.size && !client.authChallengeSent) {
        this.send(client, ["AUTH", client.authChallenge]);
        client.authChallengeSent = true;
      }
      for (const pubkey of client.authenticatedPubkeys) authenticatedPubkeys.add(pubkey);
      if (!this.clientAccess(client).allowed) continue;
      authorizedConnections++;
      for (const pubkey of client.authenticatedPubkeys) activePubkeys.add(pubkey);
    }
    const restricted = this.settings.accessMode !== "all";
    return {
      connectedClients: this.clients.size,
      authenticatedUsers: authenticatedPubkeys.size,
      effectiveUsers: restricted ? activePubkeys.size : authorizedConnections,
      activeUsers: [...activePubkeys].sort().map(pubkey => ({
        pubkey,
        name: this.settings.accessUsers.find(user => user.pubkey === pubkey)?.name || ""
      }))
    };
  }

  async fetch(request) {
    try {
      return await this.handleFetch(request);
    } catch (error) {
      console.error("RelayHub request failed", error);
      return json({ error: "durable object error", message: errorMessage(error) }, 500);
    }
  }

  async handleFetch(request) {
    await this.load();
    this.ensureRuntimeSettings();
    const url = new URL(request.url);
    const clientStats = this.clientStatistics();
    const clientSubscriptions = [...this.clients.values()].reduce((n, c) => n + c.subscriptions.size, 0);
    const upstreamSubscriptions = [...this.upstreams.values()].reduce((n, u) => n + u.routes.size, 0);
    const upstreamCounts = [...this.upstreams.values()].reduce((n, u) => n + (u.countRoutes?.size || 0), 0);
    const upstreamNegentropy = [...this.upstreams.values()].reduce((n, u) => n + (u.negRoutes?.size || 0), 0);

    if (url.pathname === "/status") return json({
      stats: this.stats,
      settings: this.settings,
      clients: clientStats.effectiveUsers,
      connectedClients: clientStats.connectedClients,
      authenticatedUsers: clientStats.authenticatedUsers,
      activeUsers: clientStats.activeUsers,
      subscriptions: clientSubscriptions,
      clientSubscriptions,
      upstreamSubscriptions,
      upstreamCounts,
      upstreamNegentropy,
      relays: this.relays
    });

    if (url.pathname === "/public-status") return json({
      name: this.settings.name,
      settings: publicStatusSettings(this.settings),
      online: this.relays.some(r => r.connected),
      clients: clientStats.effectiveUsers,
      subscriptions: clientSubscriptions,
      clientSubscriptions,
      upstreamSubscriptions,
      upstreamCounts,
      upstreamNegentropy,
      stats: this.stats,
      relays: this.relays.map(({ url, enabled, connected, reconnects, lastConnectedAt, latencyMs }) => ({ url, enabled, connected, reconnects, lastConnectedAt, latencyMs }))
    }, 200, { "access-control-allow-origin": "*", "cache-control": "no-store" });

    if (url.pathname === "/nip11") {
      return new Response(JSON.stringify(nip11Info(this.settings)), {
        headers: nip11Headers()
      });
    }

    if (url.pathname === "/settings" && request.method === "GET")
      return json(this.settings);

    if (url.pathname === "/settings" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const rawAccessUsers = body && Object.prototype.hasOwnProperty.call(body, "accessUsers") ? body.accessUsers : body.accessPubkeys;
      const invalidAccessUsers = accessUserInputs(rawAccessUsers).filter(item => !decodeNpub(item.pubkey));
      if (invalidAccessUsers.length)
        return json({ error: "invalid access public key", message: "每行必须是完整的 npub 或 64 位十六进制公钥" }, 400);
      this.settings = normalizeSettings(body, this.env);
      if (this.settings.priorityRelay && !this.relays.some(relay => relay.url === this.settings.priorityRelay))
        this.settings.priorityRelay = "";
      await this.persist();
      if (this.settings.accessMode !== "all") {
        for (const client of this.clients.values()) {
          this.ensureClientState(client);
          if (!client.authenticatedPubkeys.size) {
            this.send(client, ["AUTH", client.authChallenge]);
            client.authChallengeSent = true;
          }
        }
      }
      return json(this.settings);
    }

    if (url.pathname === "/relays" && request.method === "GET")
      return json(this.relays);

    if (url.pathname === "/relays" && request.method === "POST") {
      const body = await request.json();
      const relay = normalizeRelayUrl(body.url);
      if (!isRelayUrl(relay)) return json({ error: "invalid relay url" }, 400);
      if (!this.relays.some(r => r.url === relay)) {
        const item = relayState(relay);
        this.relays.push(item);
        await this.persist();
        this.connectUpstream(relay);
      }
      return json(this.relays);
    }

    if (url.pathname === "/relays" && request.method === "DELETE") {
      const body = await request.json();
      const relay = String(body.url || "");
      const u = this.upstreams.get(relay);
      if (u?.ws) try { u.ws.close(1000, "removed"); } catch {}
      this.upstreams.delete(relay);
      this.relays = this.relays.filter(r => r.url !== relay);
      if (this.settings.priorityRelay === relay) this.settings.priorityRelay = "";
      await this.persist();
      return json(this.relays);
    }

    if (url.pathname === "/relays/toggle" && request.method === "POST") {
      const body = await request.json();
      const item = this.relays.find(r => r.url === body.url);
      if (!item) return json({ error: "not found" }, 404);
      item.enabled = body.enabled !== false;
      if (item.enabled) this.connectUpstream(item.url);
      else {
        const u = this.upstreams.get(item.url);
        if (u?.ws) try { u.ws.close(1000, "disabled"); } catch {}
        this.upstreams.delete(item.url);
      }
      await this.persist();
      return json(this.relays);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.acceptClient(request);
    }

    return json({ error: "not found" }, 404);
  }

  acceptClient(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const clientId = crypto.randomUUID();
    const state = {
      id: clientId,
      ws: server,
      subscriptions: new Map(),
      counts: new Map(),
      negentropy: new Map(),
      seen: new Map(),
      authenticatedPubkeys: new Set(),
      authChallenge: crypto.randomUUID(),
      authChallengeSent: false,
      relayHost: relayHost(request.url),
      createdAt: Date.now()
    };
    this.clients.set(clientId, state);
    this.stats.connections++;

    server.accept();
    server.serializeAttachment({ clientId });
    server.addEventListener("message", e => {
      this.onClientMessage(clientId, e.data).catch(error => {
        console.error("Client WebSocket message failed", error);
        const current = this.clients.get(clientId);
        if (current) this.send(current, ["NOTICE", "internal error while processing message"]);
      });
    });
    server.addEventListener("close", () => {
      try { this.closeClient(clientId); }
      catch (error) { console.error("Client WebSocket close failed", error); }
    });
    server.addEventListener("error", () => {
      try { this.closeClient(clientId); }
      catch (error) { console.error("Client WebSocket error cleanup failed", error); }
    });

    if (this.settings.accessMode !== "all") {
      this.send(state, ["AUTH", state.authChallenge]);
      state.authChallengeSent = true;
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async onClientMessage(clientId, raw) {
    const c = this.clients.get(clientId);
    if (!c || typeof raw !== "string") return;
    this.ensureClientState(c);
    let msg;
    try { msg = JSON.parse(raw); } catch {
      try { c.ws.send(JSON.stringify(["NOTICE", "invalid JSON"])); } catch {}
      return;
    }
    if (!Array.isArray(msg) || !msg[0]) return;
    this.recordTraffic("upload", "client", raw, msg);
    const type = msg[0];

    if (type === "AUTH") return this.authenticateClient(c, msg[1]);

    if (type !== "CLOSE") {
      const access = this.clientAccess(c);
      if (!access.allowed) return this.rejectClientMessage(c, msg, access.reason);
    }

    if (type === "EVENT") {
      const event = msg[1];
      if (!event?.id) return this.send(c, ["NOTICE", "invalid EVENT"]);
      if (Array.isArray(event.tags) && event.tags.some(tag => Array.isArray(tag) && tag[0] === "-")) {
        return this.send(c, ["OK", event.id, false, "auth-required: protected events are not accepted by this proxy"]);
      }
      this.stats.events++;
      this.stats.forwarded++;
      let ok = false;
      for (const u of this.writeUpstreams()) {
        const payload = JSON.stringify(["EVENT", event]);
        try {
          u.ws.send(payload);
          ok = true;
          const relay = this.relays.find(r => r.url === u.url);
          if (relay) {
            relay.forwardedEvents = (relay.forwardedEvents || 0) + 1;
            relay.uploadedMessages = (relay.uploadedMessages || 0) + 1;
            relay.uploadedBytes = (relay.uploadedBytes || 0) + byteLength(payload);
          }
        } catch {}
      }
      if (ok && Date.now() - this.lastPersistAt > 10000) this.persist().catch(() => {});
      this.send(c, ["OK", event.id, ok, ok ? "forwarded" : "no upstream relay available"]);
      return;
    }

    if (type === "COUNT") {
      const subId = String(msg[1] || "");
      const filters = msg.slice(2);
      if (!this.validSubscriptionRequest(subId, filters, raw))
        return this.send(c, ["CLOSED", subId, "rate-limited: subscription request is too large"]);
      const open = this.preferredUpstreams();
      if (!open.length) return this.send(c, ["CLOSED", subId, "error: no upstream relay available"]);
      const state = { filters, upstreamIds: new Map(), pending: 0, count: 0, approximate: open.length > 1, hll: "", responded: false, closedReason: "", timer: null };
      c.counts.set(subId, state);
      for (const u of open) {
        const upstreamId = `${clientId}:count:${subId}:${crypto.randomUUID().slice(0, 8)}`;
        state.upstreamIds.set(u.url, upstreamId);
        state.pending++;
        u.countRoutes.set(upstreamId, { clientId, subId });
        try { u.ws.send(JSON.stringify(["COUNT", upstreamId, ...filters])); } catch {
          state.pending--;
          u.countRoutes.delete(upstreamId);
          state.closedReason = "error: failed to forward count request";
        }
      }
      state.timer = setTimeout(() => this.finishCount(clientId, subId, true), 1500);
      if (state.pending <= 0) this.finishCount(clientId, subId, true);
      return;
    }

    if (type === "REQ") {
      const subId = String(msg[1] || "");
      const filters = msg.slice(2);
      if (!this.validSubscriptionRequest(subId, filters, raw))
        return this.send(c, ["CLOSED", subId, "rate-limited: subscription request is too large"]);
      if (!c.subscriptions.has(subId) && c.subscriptions.size >= DEFAULT_MAX_CLIENT_SUBSCRIPTIONS)
        return this.send(c, ["CLOSED", subId, "rate-limited: too many active subscriptions"]);
      // NIP-01 uses the subscription id as the replacement key.  Without
      // closing its previous upstream routes, clients that refresh filters
      // quickly leak subscriptions until an upstream starts rate-limiting.
      this.closeSubscription(c, subId);
      c.subscriptions.set(subId, { filters, upstreamIds: new Map() });
      // Always include the configured priority relay, then use at most two
      // low-latency upstreams for redundancy without querying the full list.
      for (const u of this.preferredUpstreams()) this.routeSubscription(c, subId, u);
      return;
    }

    if (type === "NEG-OPEN") {
      const negId = String(msg[1] || "");
      if (!negId) return;
      const u = this.openUpstreams()[0];
      if (!u) return this.send(c, ["NEG-ERR", negId, "error: no upstream relay available"]);
      const upstreamId = `${clientId}:neg:${negId}:${crypto.randomUUID().slice(0, 8)}`;
      c.negentropy.set(negId, { url: u.url, upstreamId });
      u.negRoutes.set(upstreamId, { clientId, negId });
      try { u.ws.send(JSON.stringify(["NEG-OPEN", upstreamId, ...msg.slice(2)])); } catch {
        c.negentropy.delete(negId);
        u.negRoutes.delete(upstreamId);
        this.send(c, ["NEG-ERR", negId, "error: failed to open upstream negentropy session"]);
      }
      return;
    }

    if (type === "NEG-MSG") {
      const negId = String(msg[1] || "");
      const route = c.negentropy.get(negId);
      const u = route ? this.upstreams.get(route.url) : null;
      if (!u?.ws || u.ws.readyState !== WebSocket.OPEN) return this.send(c, ["NEG-ERR", negId, "error: upstream negentropy session is not available"]);
      try { u.ws.send(JSON.stringify(["NEG-MSG", route.upstreamId, ...msg.slice(2)])); } catch {
        this.send(c, ["NEG-ERR", negId, "error: failed to forward negentropy message"]);
      }
      return;
    }

    if (type === "NEG-CLOSE") {
      const negId = String(msg[1] || "");
      const route = c.negentropy.get(negId);
      const u = route ? this.upstreams.get(route.url) : null;
      if (u) {
        u.negRoutes.delete(route.upstreamId);
        if (u.ws?.readyState === WebSocket.OPEN)
          try { u.ws.send(JSON.stringify(["NEG-CLOSE", route.upstreamId])); } catch {}
      }
      c.negentropy.delete(negId);
      return;
    }

    if (type === "CLOSE") {
      const subId = String(msg[1] || "");
      this.closeSubscription(c, subId);
    }
  }

  authenticateClient(c, event) {
    this.ensureClientState(c);
    const eventId = typeof event?.id === "string" ? event.id : "";
    const fail = reason => this.send(c, ["OK", eventId, false, reason]);
    if (!event || event.kind !== 22242 || !/^[0-9a-f]{64}$/i.test(event.pubkey || ""))
      return fail("invalid: expected a NIP-42 authentication event");
    if (!Number.isFinite(event.created_at) || Math.abs(Date.now() / 1000 - event.created_at) > 600)
      return fail("invalid: authentication event is expired");
    const challenge = event.tags?.find(tag => Array.isArray(tag) && tag[0] === "challenge")?.[1];
    const relay = event.tags?.find(tag => Array.isArray(tag) && tag[0] === "relay")?.[1];
    if (challenge !== c.authChallenge || relayHost(relay) !== c.relayHost)
      return fail("invalid: authentication challenge or relay does not match");
    if (!verifyEvent(event)) return fail("invalid: authentication signature is invalid");
    c.authenticatedPubkeys.add(event.pubkey.toLowerCase());
    this.send(c, ["OK", eventId, true, "authenticated"]);
  }

  clientAccess(c) {
    this.ensureRuntimeSettings();
    this.ensureClientState(c);
    const mode = this.settings.accessMode;
    if (mode === "all") return { allowed: true };
    if (!c.authenticatedPubkeys.size)
      return { allowed: false, reason: "auth-required: authenticate with NIP-42 to use this relay" };
    const listed = this.settings.accessPubkeys.some(pubkey => c.authenticatedPubkeys.has(pubkey));
    if (mode === "whitelist" && !listed)
      return { allowed: false, reason: "restricted: this pubkey is not on the relay whitelist" };
    if (mode === "blacklist" && listed)
      return { allowed: false, reason: "restricted: this pubkey is blocked by the relay" };
    return { allowed: true };
  }

  rejectClientMessage(c, msg, reason) {
    const type = msg[0];
    if (type === "EVENT") return this.send(c, ["OK", String(msg[1]?.id || ""), false, reason]);
    if (type === "REQ" || type === "COUNT") return this.send(c, ["CLOSED", String(msg[1] || ""), reason]);
    if (type === "NEG-OPEN" || type === "NEG-MSG" || type === "NEG-CLOSE")
      return this.send(c, ["NEG-ERR", String(msg[1] || ""), reason]);
    return this.send(c, ["NOTICE", reason]);
  }

  openUpstreams() {
    return [...this.upstreams.values()].filter(u => u.ws && u.ws.readyState === WebSocket.OPEN);
  }

  preferredUpstreams() {
    const open = this.openUpstreams();
    const priority = open.find(upstream => upstream.url === this.settings.priorityRelay);
    const secondary = open
      .filter(upstream => upstream !== priority)
      .sort((left, right) => {
        const a = this.relays.find(relay => relay.url === left.url)?.latencyMs;
        const b = this.relays.find(relay => relay.url === right.url)?.latencyMs;
        return (Number.isFinite(a) ? a : Number.MAX_SAFE_INTEGER) - (Number.isFinite(b) ? b : Number.MAX_SAFE_INTEGER);
      })
      .slice(0, DEFAULT_MAX_SECONDARY_RELAYS);
    return priority ? [priority, ...secondary] : secondary;
  }

  writeUpstreams() {
    const priority = this.settings.priorityRelay;
    return this.openUpstreams().sort((left, right) => {
      if (left.url === priority) return -1;
      if (right.url === priority) return 1;
      return 0;
    });
  }

  maxSubscriptionRelayCount() {
    return this.settings.priorityRelay ? DEFAULT_MAX_SECONDARY_RELAYS + 1 : DEFAULT_MAX_SECONDARY_RELAYS;
  }

  validSubscriptionRequest(subId, filters, raw = "") {
    return subId.length > 0 && subId.length <= 64 &&
      filters.length > 0 && filters.length <= DEFAULT_MAX_FILTERS_PER_SUBSCRIPTION &&
      byteLength(raw) <= DEFAULT_MAX_SUBSCRIPTION_BYTES &&
      filters.every(filter => filter && typeof filter === "object" && !Array.isArray(filter));
  }

  routeSubscription(c, subId, u) {
    const sub = c.subscriptions.get(subId);
    if (!sub || sub.upstreamIds.has(u.url) || sub.upstreamIds.size >= this.maxSubscriptionRelayCount()) return;
    const upstreamId = `${c.id}:${subId}:${crypto.randomUUID().slice(0, 8)}`;
    sub.upstreamIds.set(u.url, upstreamId);
    u.routes.set(upstreamId, { clientId: c.id, subId });
    try { u.ws.send(JSON.stringify(["REQ", upstreamId, ...sub.filters])); } catch {
      sub.upstreamIds.delete(u.url);
      u.routes.delete(upstreamId);
    }
  }

  closeSubscription(c, subId) {
    const sub = c.subscriptions.get(subId);
    if (!sub) return;
    for (const [url, upstreamId] of sub.upstreamIds) {
      const u = this.upstreams.get(url);
      if (!u) continue;
      u.routes.delete(upstreamId);
      if (u.ws?.readyState === WebSocket.OPEN)
        try { u.ws.send(JSON.stringify(["CLOSE", upstreamId])); } catch {}
    }
    c.subscriptions.delete(subId);
    const prefix = `${subId}:`;
    for (const key of c.seen.keys()) {
      if (key.startsWith(prefix)) c.seen.delete(key);
    }
  }

  closeClient(clientId) {
    const c = this.clients.get(clientId);
    if (!c) return;
    for (const subId of [...c.subscriptions.keys()]) this.closeSubscription(c, subId);
    for (const count of c.counts.values()) {
      if (count.timer) clearTimeout(count.timer);
      for (const [url, upstreamId] of count.upstreamIds) {
        const u = this.upstreams.get(url);
        if (u) u.countRoutes.delete(upstreamId);
      }
    }
    for (const route of c.negentropy.values()) {
      const u = this.upstreams.get(route.url);
      if (u) u.negRoutes.delete(route.upstreamId);
    }
    this.clients.delete(clientId);
  }

  finishCount(clientId, subId, approximate = false) {
    const c = this.clients.get(clientId);
    const count = c?.counts.get(subId);
    if (!c || !count) return;
    if (count.timer) clearTimeout(count.timer);
    for (const [url, upstreamId] of count.upstreamIds) {
      const u = this.upstreams.get(url);
      if (u) u.countRoutes.delete(upstreamId);
    }
    if (!count.responded) {
      this.send(c, ["CLOSED", subId, count.closedReason || "error: count request was not answered by upstream relays"]);
    } else {
      const body = { count: count.count, approximate: count.approximate || approximate };
      if (count.hll) body.hll = count.hll;
      this.send(c, ["COUNT", subId, body]);
    }
    c.counts.delete(subId);
  }

  connectUpstream(url) {
    const existing = this.upstreams.get(url);
    if (existing?.connecting || existing?.ws?.readyState === WebSocket.OPEN) return;
    const item = this.relays.find(r => r.url === url);
    if (!item?.enabled) return;

    const startedAt = Date.now();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      item.connected = false;
      item.lastError = errorMessage(error);
      const delay = reconnectDelayMs(item.reconnectDelayMs || 1000);
      item.reconnectDelayMs = delay;
      item.nextReconnectAt = Date.now() + delay;
      this.persist().catch(() => {});
      if (item.enabled) setTimeout(() => this.connectUpstream(url), delay);
      return;
    }
    const u = {
      url, ws, routes: new Map(), countRoutes: new Map(), negRoutes: new Map(), connecting: true, reconnectTimer: null,
      backoff: Math.min((existing?.backoff || 1000) * 2, 30000), openedAt: 0
    };
    this.upstreams.set(url, u);

    ws.addEventListener("open", () => {
      u.connecting = false;
      u.backoff = 1000;
      u.openedAt = Date.now();
      item.nextReconnectAt = null;
      item.connected = true;
      item.lastConnectedAt = Date.now();
      item.latencyMs = Math.max(0, Date.now() - startedAt);
      item.lastLatencyAt = Date.now();
      item.lastError = null;
      this.persist().catch(() => {});
      for (const c of this.clients.values()) {
        this.ensureClientState(c);
        for (const [subId, sub] of c.subscriptions) {
          if (sub.upstreamIds.size >= this.maxSubscriptionRelayCount()) continue;
          if (this.preferredUpstreams().some(candidate => candidate.url === url))
            this.routeSubscription(c, subId, u);
        }
      }
    });

    ws.addEventListener("message", e => {
      try { this.onUpstreamMessage(url, e.data); }
      catch (error) { console.error("Upstream WebSocket message failed", error); }
    });
    ws.addEventListener("error", () => {
      item.lastError = "upstream websocket error";
      this.persist().catch(() => {});
    });
    ws.addEventListener("close", () => {
      item.connected = false;
      const affectedSubscriptions = [];
      for (const [upstreamId, route] of u.routes) {
        const c = this.clients.get(route.clientId);
        if (c) this.ensureClientState(c);
        const sub = c?.subscriptions.get(route.subId);
        if (sub?.upstreamIds.get(url) === upstreamId) {
          sub.upstreamIds.delete(url);
          affectedSubscriptions.push([c, route.subId]);
        }
      }
      for (const route of [...u.countRoutes.values()]) {
        const c = this.clients.get(route.clientId);
        if (c) this.ensureClientState(c);
        const count = c?.counts.get(route.subId);
        if (count) {
          count.pending = Math.max(0, count.pending - 1);
          count.approximate = true;
          count.closedReason = "error: upstream relay disconnected";
          if (count.pending === 0) this.finishCount(route.clientId, route.subId, true);
        }
      }
      for (const route of [...u.negRoutes.values()]) {
        const c = this.clients.get(route.clientId);
        if (c) this.ensureClientState(c);
        if (c) {
          this.send(c, ["NEG-ERR", route.negId, "error: upstream relay disconnected"]);
          c.negentropy.delete(route.negId);
        }
      }
      this.upstreams.delete(url);
      for (const [c, subId] of affectedSubscriptions) {
        for (const candidate of this.preferredUpstreams()) this.routeSubscription(c, subId, candidate);
      }
      this.stats.reconnects++;
      item.reconnects = (item.reconnects || 0) + 1;
      const stable = u.openedAt && Date.now() - u.openedAt >= 30000;
      const delay = reconnectDelayMs(stable ? 1000 : (item.reconnectDelayMs || 1000));
      item.reconnectDelayMs = delay;
      item.nextReconnectAt = Date.now() + delay;
      this.persist().catch(() => {});
      if (item.enabled) {
        try { setTimeout(() => this.connectUpstream(url), delay); } catch {}
      }
    });
  }

  onUpstreamMessage(url, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg) || !msg[0]) return;
    const u = this.upstreams.get(url);
    if (!u) return;
    this.recordTraffic("download", url, raw, msg);

    if (msg[0] === "COUNT") {
      const upstreamId = String(msg[1] || "");
      const route = u.countRoutes.get(upstreamId);
      if (!route) return;
      const c = this.clients.get(route.clientId);
      const count = c?.counts.get(route.subId);
      if (!c || !count) return;
      const body = msg[2] && typeof msg[2] === "object" ? msg[2] : {};
      const value = Number(body.count);
      count.count += Number.isFinite(value) ? Math.max(0, value) : 0;
      count.approximate = count.approximate || body.approximate !== false;
      count.hll = mergeHll(count.hll, body.hll);
      count.responded = true;
      count.pending = Math.max(0, count.pending - 1);
      u.countRoutes.delete(upstreamId);
      count.upstreamIds.delete(url);
      if (count.pending === 0) this.finishCount(route.clientId, route.subId);
      return;
    }

    if (msg[0] === "CLOSED" && u.countRoutes.has(String(msg[1] || ""))) {
      const upstreamId = String(msg[1] || "");
      const route = u.countRoutes.get(upstreamId);
      const c = this.clients.get(route.clientId);
      const count = c?.counts.get(route.subId);
      u.countRoutes.delete(upstreamId);
      if (!count) return;
      count.upstreamIds.delete(url);
      count.approximate = true;
      count.closedReason = String(msg[2] || count.closedReason || "error: upstream relay closed count request");
      count.pending = Math.max(0, count.pending - 1);
      if (count.pending === 0) this.finishCount(route.clientId, route.subId, true);
      return;
    }

    if (msg[0] === "NEG-MSG" || msg[0] === "NEG-ERR") {
      const upstreamId = String(msg[1] || "");
      const route = u.negRoutes.get(upstreamId);
      if (!route) return;
      const c = this.clients.get(route.clientId);
      if (!c) return;
      this.send(c, [msg[0], route.negId, ...msg.slice(2)]);
      if (msg[0] === "NEG-ERR") {
        u.negRoutes.delete(upstreamId);
        c.negentropy.delete(route.negId);
      }
      return;
    }

    if (msg[0] === "EVENT" && msg[1]) {
      const upstreamId = String(msg[1]);
      const route = u.routes.get(upstreamId);
      if (!route) return;
      const c = this.clients.get(route.clientId);
      if (!c) return;
      const event = msg[2];
      const key = `${route.subId}:${event?.id}`;
      if (c.seen.has(key)) {
        this.stats.deduped++;
        return;
      }
      c.seen.set(key, Date.now());
      this.send(c, ["EVENT", route.subId, event]);
      // Keep a bounded per-client memory footprint.  In normal use entries
      // are released immediately when their subscription is closed.
      if (c.seen.size > 20000) {
        const first = c.seen.keys().next().value;
        c.seen.delete(first);
      }
      return;
    }

    const upstreamId = String(msg[1] || "");
    const route = u.routes.get(upstreamId);
    if (!route) return;
    const c = this.clients.get(route.clientId);
    if (!c) return;

    if (msg[0] === "EOSE") {
      this.send(c, ["EOSE", route.subId]);
      return;
    }

    if (msg[0] === "CLOSED") {
      // A single upstream may reject a request (for example due to its own
      // rate limit) while other upstream relays can still satisfy it. Remove
      // only that route and notify the client only when none are left.
      u.routes.delete(upstreamId);
      const sub = c.subscriptions.get(route.subId);
      if (sub?.upstreamIds.get(url) === upstreamId) sub.upstreamIds.delete(url);
      if (sub?.upstreamIds.size) return;
      c.subscriptions.delete(route.subId);
      this.send(c, ["CLOSED", route.subId, ...msg.slice(2)]);
      return;
    }

    if (msg[0] === "OK" || msg[0] === "NOTICE") {
      this.send(c, msg[0] === "OK" ? ["OK", ...msg.slice(1)] : ["NOTICE", ...msg.slice(1)]);
    }
  }

  send(c, msg) {
    try { c.ws.send(JSON.stringify(msg)); } catch {}
  }
}

const BASE_STYLE = `
:root{color-scheme:dark;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0e14;color:#eef1f7}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b0e14;background-image:linear-gradient(180deg,#10151e 0,#0b0e14 290px)}a{color:inherit}.shell{max-width:1180px;margin:auto;padding:22px 20px 48px}.admin-shell{max-width:1440px}.nav{display:flex;justify-content:space-between;align-items:center;gap:14px;padding-bottom:18px;border-bottom:1px solid #242b36}.brand{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:700;letter-spacing:-.015em}.mark{width:30px;height:30px;border:1px solid #3d4859;border-radius:8px;display:grid;place-items:center;background:#161c26;color:#b7c9ff;font-size:16px}.eyebrow{color:#8ea2ba;text-transform:uppercase;letter-spacing:.11em;font-size:10px;font-weight:700}.hero{padding:48px 0 30px;max-width:700px}.admin-hero{padding:26px 0 18px;max-width:none}.hero h1{font-size:clamp(32px,4.6vw,52px);letter-spacing:-.055em;line-height:1.08;margin:10px 0 12px}.admin-hero h1{font-size:clamp(26px,3vw,36px)!important;margin:7px 0}.lead{max-width:660px;margin:0;color:#9aa8bb;font-size:15px;line-height:1.65}.admin-hero .lead{font-size:14px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.button{border:1px solid #344052;border-radius:8px;padding:8px 12px;background:#171e29;color:#eaf0fb;font:600 13px/1.35 inherit;cursor:pointer;text-decoration:none}.button.primary{background:#dfe8ff;color:#172033;border-color:#dfe8ff}.button.danger{background:#2a171d;border-color:#5a303b;color:#ffc2cf}.button:hover{border-color:#718198}.button.primary:hover{filter:brightness(.94)}.panel{background:#111720;border:1px solid #252e3b;border-radius:12px;box-shadow:0 1px 1px #0004}.status-bar{display:flex;align-items:center;gap:8px;color:#b8c4d4;font-size:13px}.dot{width:7px;height:7px;border-radius:50%;background:#d46a78}.dot.on{background:#5ac58a}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.home-metrics{grid-template-columns:repeat(5,1fr)}.admin-shell .grid{grid-template-columns:repeat(auto-fit,minmax(132px,1fr))}.metric{padding:14px}.admin-shell .metric{padding:11px}.metric .value{font-weight:700;font-size:24px;letter-spacing:-.045em}.admin-shell .metric .value{font-size:19px}.home-metrics .value{font-size:21px}.metric .label,.muted{font-size:12px;color:#8493a7}.section{margin-top:14px;padding:18px}.admin-shell .section{padding:16px}.section h2{font-size:15px;letter-spacing:-.015em;margin:0 0 5px}.relay-list{display:grid;gap:7px;margin-top:14px}.relay{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 12px;border-radius:9px;background:#0d121a;border:1px solid #222b37}.relay-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}.badge{font-size:11px;padding:3px 7px;border-radius:999px;background:#252e3b;color:#c6d0df;white-space:nowrap}.badge.on{background:#153b2e;color:#8ee0b5}.badge.off{background:#3b2229;color:#f2a6b5}.copy{font:inherit;border:0;background:transparent;color:#9bb9ff;cursor:pointer;padding:0;font-size:12px}.admin-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:14px}.relay-admin-grid{grid-template-columns:minmax(0,3fr) minmax(270px,.9fr)}.form-row{display:flex;gap:8px;margin-top:14px}.form-row input{flex:1;min-width:0}.input{border:1px solid #303b4b;border-radius:8px;padding:9px 10px;background:#0c1119;color:#eef1f7;font:13px/1.35 inherit}.input:focus{outline:2px solid #8ca8e855;border-color:#8ca8e8}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;margin-top:11px}.table th,.table td{padding:10px 7px;text-align:left;border-bottom:1px solid #222b37;font-size:12px}.relay-panel .table th,.relay-panel .table td{padding:8px 7px;font-size:11px;white-space:nowrap}.table th{font-size:10px;color:#74849a;text-transform:uppercase;letter-spacing:.07em}.table td:first-child{word-break:break-all;min-width:210px}.relay-panel .table td:first-child{min-width:270px;white-space:normal}.mini{padding:5px 8px;border-radius:7px;font-size:11px}.relay-panel .mini{padding:4px 7px}.notice{display:none;margin-top:10px;color:#ffb5c3;font-size:12px}.login{max-width:390px;margin:12vh auto;padding:24px}.login h1{font-size:27px;letter-spacing:-.04em;margin:15px 0 7px}.login form{display:grid;gap:9px;margin-top:20px}.login .button{width:100%}@media(max-width:900px){.home-metrics{grid-template-columns:repeat(2,1fr)}.admin-shell .grid{grid-template-columns:repeat(2,1fr)}.relay-admin-grid{grid-template-columns:1fr}}@media(max-width:720px){.shell{padding:14px 12px 30px}.nav{align-items:flex-start;padding-bottom:12px}.nav .actions{margin-top:0!important}.brand{font-size:13px}.hero{padding:28px 0 20px}.admin-hero{padding:18px 0 10px}.hero h1{font-size:29px}.admin-hero h1{font-size:25px!important}.lead{font-size:13px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.metric{padding:11px}.metric .value,.home-metrics .value{font-size:19px}.admin-grid{grid-template-columns:1fr}.section,.admin-shell .section{padding:13px}.relay{align-items:flex-start;flex-direction:column}.form-row{flex-direction:column}.form-row .button{width:100%}.status-bar{align-items:flex-start;flex-wrap:wrap}.table-wrap{overflow:visible}.relay-panel .table,.relay-panel .table tbody,.relay-panel .table tr,.relay-panel .table td{display:block;width:100%}.relay-panel .table thead{display:none}.relay-panel .table tr{padding:9px 10px;margin:9px 0;border:1px solid #26303d;border-radius:9px;background:#0c1119}.relay-panel .table td{min-width:0!important;white-space:normal!important;padding:5px 0;border:0;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;text-align:right;word-break:break-word}.relay-panel .table td::before{content:attr(data-label);flex:0 0 70px;color:#7e8da2;font-size:10px;text-align:left}.relay-panel .table td:last-child{justify-content:flex-end;gap:6px;padding-top:8px}.relay-panel .table td:last-child::before{margin-right:auto}.relay-panel .mini{padding:5px 7px}.login{margin:8vh auto;padding:19px}.login h1{font-size:24px}}
`;

const HOME_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nostr Relay Proxy</title><style>${BASE_STYLE}</style></head><body><main class="shell"><nav class="nav"><div class="brand"><span class="mark">ϟ</span>Nostr Relay Proxy</div><a class="button" href="/admin">管理后台</a></nav><section class="hero"><div class="eyebrow">Multi-relay gateway</div><h1>一个更可靠的<br> Nostr 连接入口。</h1><p class="lead">聚合多个上游 Relay，为你的客户端提供统一、稳定的 WebSocket 连接。页面只在打开或手动刷新浏览器时读取一次状态，尽量节省 Cloudflare 免费额度。</p><div class="actions"><button class="button primary" id="copy">复制连接地址</button></div></section><section class="panel section"><div class="status-bar"><span id="dot" class="dot"></span><span id="summary">正在获取网络状态…</span><span class="muted" id="updated"></span></div><div class="grid home-metrics" id="metrics" style="margin-top:20px"></div></section><section class="panel section"><h2>上游 Relay</h2><p class="muted">已连接的上游会自动同步订阅；离线节点会采用退避策略重连。</p><div class="relay-list" id="relays"><div class="muted">加载中…</div></div></section></main><script>
const wsUrl=location.origin.replace(/^http/,'ws')+'/';document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(wsUrl);document.getElementById('copy').textContent='已复制 '+wsUrl;setTimeout(()=>document.getElementById('copy').textContent='复制连接地址',1800)};
const ago=n=>{if(!n)return '—';let s=Math.max(0,Math.floor((Date.now()-n)/1000));let h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h? h+' 小时 '+m+' 分钟':m?m+' 分钟':'刚刚'};
function metric(label,value){let el=document.createElement('div');el.className='metric panel';el.innerHTML='<div class="value"></div><div class="label"></div>';el.children[0].textContent=value;el.children[1].textContent=label;return el}
let refreshTimer;function schedule(seconds=60){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,Math.max(60,Number(seconds)||60)*1000)}async function refresh(){try{const r=await fetch('/status',{cache:'no-store'});const s=await r.json();const active=s.relays.filter(x=>x.connected).length;const dot=document.getElementById('dot');dot.className='dot '+(s.online?'on':'');document.getElementById('summary').textContent=s.online?'服务在线 · '+active+' 个上游已连接':'正在等待上游 Relay 连接';document.getElementById('updated').textContent='读取于 '+new Date().toLocaleTimeString();const metrics=document.getElementById('metrics');metrics.replaceChildren(metric('在线用户',s.clients),metric('客户端活跃订阅',s.clientSubscriptions??s.subscriptions),metric('上游活跃订阅',s.upstreamSubscriptions??0),metric('可用 Relay',active+' / '+s.relays.length),metric('服务运行',ago(s.stats.startedAt)));const list=document.getElementById('relays');list.replaceChildren(...s.relays.map(x=>{let row=document.createElement('div');row.className='relay';let left=document.createElement('div');let name=document.createElement('div');name.className='relay-name';name.textContent=x.url;let meta=document.createElement('div');meta.className='muted';meta.textContent=x.connected?'已连接 '+ago(x.lastConnectedAt):x.enabled?'等待重连 · 已重连 '+x.reconnects+' 次':'已由管理员停用';left.append(name,meta);let badge=document.createElement('span');badge.className='badge '+(x.connected?'on':'off');badge.textContent=x.connected?'在线':'离线';row.append(left,badge);return row}));schedule(s.settings?.statusRefreshSeconds)}catch{document.getElementById('summary').textContent='暂时无法读取状态';schedule()}}
refresh();</script></body></html>`;

const LOGIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · Nostr Relay Proxy</title><style>${BASE_STYLE}</style></head><body><main class="shell"><div class="panel login"><div class="brand"><span class="mark">ϟ</span>Nostr Relay Proxy</div><h1>欢迎回来</h1><p class="muted">登录后管理上游 Relay 与实时网络状态。</p><form id="form"><input class="input" id="username" autocomplete="username" placeholder="管理员用户名" required><input class="input" id="password" type="password" autocomplete="current-password" placeholder="密码" required><button class="button primary" id="submit">安全登录</button><div class="notice" id="notice">__ERROR__</div></form></div></main><script>document.getElementById('form').onsubmit=async e=>{e.preventDefault();const b=document.getElementById('submit');b.disabled=true;b.textContent='登录中…';const user=document.getElementById('username').value;const pass=document.getElementById('password').value;const r=await fetch('/admin/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:user,password:pass})});if(r.ok){location.href='/admin';return}const d=await r.json().catch(()=>({error:'登录失败'}));const n=document.getElementById('notice');n.textContent=d.error||'登录失败';n.style.display='block';b.disabled=false;b.textContent='安全登录'}</script></body></html>`;

const ADMIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理后台 · Nostr Relay Proxy</title><style>${BASE_STYLE}</style></head><body><main class="shell admin-shell"><nav class="nav"><div class="brand"><span class="mark">ϟ</span>Nostr Relay Proxy <span class="badge on">管理后台</span></div><div class="actions" style="margin:0"><a class="button" href="/">查看前台</a><button class="button" id="logout">退出</button></div></nav><section class="hero admin-hero"><div class="eyebrow">Control center</div><h1>Relay 网络控制台</h1><p class="lead">打开页面时读取一次连接、流量与上游健康状态；需要最新数据时请手动刷新浏览器页面。</p></section><div class="grid" id="metrics"></div><section class="admin-grid relay-admin-grid" style="margin-top:18px"><div class="panel section relay-panel"><h2>上游 Relay</h2><p class="muted">启用后立即连接；停用不会删除配置。</p><div class="form-row"><input class="input" id="url" placeholder="relay.example.com" aria-label="Relay 地址"><button class="button primary" id="add">添加 Relay</button></div><div class="notice" id="notice"></div><div class="table-wrap"><table class="table"><thead><tr><th>地址</th><th>状态</th><th>延迟</th><th>连接时长</th><th>转发</th><th>下载</th><th>上传</th><th>下载量</th><th>重连</th><th>最后错误</th><th>操作</th></tr></thead><tbody id="relays"></tbody></table></div></div><aside class="panel section"><h2>连接信息</h2><p class="muted">将以下地址填入 Nostr 客户端。</p><div class="relay-name" id="ws"></div><button class="copy" id="copy" style="margin-top:10px">复制 WebSocket 地址</button><hr style="border:0;border-top:1px solid #28445f;margin:24px 0"><div class="muted">服务运行时间</div><div class="value" style="font-size:25px;margin-top:6px" id="uptime">—</div><hr style="border:0;border-top:1px solid #28445f;margin:22px 0"><h2>中继资料</h2><div class="form-row" style="flex-direction:column"><input class="input" id="set-name" placeholder="中继名称"><input class="input" id="set-desc" placeholder="描述"><input class="input" id="set-pubkey" placeholder="机主公钥 hex"><input class="input" id="set-contact" placeholder="联系方式，例如 mailto:you@example.com"><input class="input" id="set-icon" placeholder="头像 URL"><div class="muted">支持的 NIPs（由程序自动声明）：01、11、45、77</div><hr style="border:0;border-top:1px solid #28445f;margin:8px 0 2px;width:100%"><h2>优先中继</h2><p class="muted" style="margin:0">读取始终经过它，再选延迟最低的两个；发布会优先发送给它并继续发送到其他在线上游。</p><select class="input" id="set-priority-relay"><option value="">不设置（仅按延迟）</option></select><button class="button primary" id="save-settings">保存资料和优先中继</button></div><div class="notice" id="settings-notice"></div><div class="muted" style="margin-top:20px">提示：上游列表、中继资料和优先中继都保存在 Durable Object；Cloudflare 中的变量仅用于首次默认值。</div></aside></section></main><script>
const elapsed=n=>{if(!n)return '—';let s=Math.floor((Date.now()-n)/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60);if(h)return h+'小时 '+m+'分';if(m)return m+'分 '+(s%60)+'秒';return s+'秒'};const size=n=>n>1048576?(n/1048576).toFixed(1)+' MB':n>1024?(n/1024).toFixed(1)+' KB':(n||0)+' B';const api=async(p,o)=>{const r=await fetch(p,o);if(r.status===401){location.href='/admin';throw Error('unauthorized')}const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'请求失败');return d};let settingsLoaded=false;function card(label,value){let e=document.createElement('div');e.className='metric panel';e.innerHTML='<div class="value"></div><div class="label"></div>';e.children[0].textContent=value;e.children[1].textContent=label;return e}function show(msg){const n=document.getElementById('notice');n.textContent=msg;n.style.display=msg?'block':'none'}function showSettings(msg,ok=true){const n=document.getElementById('settings-notice');n.textContent=msg;n.style.display=msg?'block':'none';n.style.color=ok?'#7ef0bd':'#ffb5c3'}function normalizeRelayUrl(v){v=v.trim();if(!v)return '';const lower=v.toLowerCase();if(lower.startsWith('wss://'))return 'wss://'+v.slice(6);if(lower.startsWith('ws://'))return 'ws://'+v.slice(5);if(v.includes('://'))return v;return 'wss://'+v}function fillSettings(s,force=false){if(!s||!force&&settingsLoaded&&document.activeElement?.id?.startsWith('set-'))return;settingsLoaded=true;document.getElementById('set-name').value=s.name||'';document.getElementById('set-desc').value=s.description||'';document.getElementById('set-pubkey').value=s.pubkey||'';document.getElementById('set-contact').value=s.contact||'';document.getElementById('set-icon').value=s.icon||''}function fillPriorityRelay(s,relays){const select=document.getElementById('set-priority-relay');const current=s?.priorityRelay||'';select.replaceChildren(new Option('不设置（仅按延迟）',''));for(const relay of relays||[]){const option=new Option(relay.url,relay.url);if(!relay.enabled)option.textContent+='（已停用）';select.append(option)}select.value=current}
async function refresh(){try{const s=await api('/admin/api/status');document.getElementById('metrics').replaceChildren(card('在线用户',s.clients),card('客户端活跃订阅',s.clientSubscriptions??s.subscriptions),card('上游活跃订阅',s.upstreamSubscriptions??0),card('上传流量',size(s.stats.uploadedBytes)),card('下载流量',size(s.stats.downloadedBytes)),card('客户端事件',s.stats.events),card('可用上游',s.relays.filter(x=>x.connected).length+' / '+s.relays.length));fillSettings(s.settings);fillPriorityRelay(s.settings,s.relays);document.getElementById('uptime').textContent=elapsed(s.stats.startedAt);const tbody=document.getElementById('relays');tbody.replaceChildren(...s.relays.map(r=>{const tr=document.createElement('tr');const values=[r.url,r.connected?'在线':r.enabled?'离线':'已停用',r.latencyMs!==null&&r.latencyMs!==undefined?r.latencyMs+' ms':'—',r.connected?elapsed(r.lastConnectedAt):'—',r.forwardedEvents||0,r.downloadedEvents||0,size(r.uploadedBytes),size(r.downloadedBytes),r.reconnects||0,r.lastError||'—'];values.forEach((v,i)=>{const td=document.createElement('td');td.textContent=v;if(i===1)td.className=r.connected?'badge on':'badge off';tr.append(td)});const actions=document.createElement('td');const toggle=document.createElement('button');toggle.className='button mini';toggle.textContent=r.enabled?'停用':'启用';toggle.onclick=()=>change('/admin/api/relays/toggle',{url:r.url,enabled:!r.enabled});const del=document.createElement('button');del.className='button danger mini';del.style.marginLeft='6px';del.textContent='删除';del.onclick=()=>{if(confirm('删除 '+r.url+'？'))change('/admin/api/relays',{url:r.url},'DELETE')};actions.append(toggle,del);tr.append(actions);return tr}));show('')}catch(e){show(e.message)}}async function change(path,body,method='POST'){try{await api(path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});refresh()}catch(e){show(e.message)}}async function saveSettings(){const b=document.getElementById('save-settings');b.disabled=true;b.textContent='保存中…';showSettings('正在保存…');try{const saved=await api('/admin/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.getElementById('set-name').value,description:document.getElementById('set-desc').value,pubkey:document.getElementById('set-pubkey').value,contact:document.getElementById('set-contact').value,icon:document.getElementById('set-icon').value,priorityRelay:document.getElementById('set-priority-relay').value})});fillSettings(saved,true);showSettings('已保存中继资料和优先中继');setTimeout(()=>showSettings(''),2200)}catch(e){showSettings(e.message||'保存失败',false)}finally{b.disabled=false;b.textContent='保存资料和优先中继'}}document.getElementById('add').onclick=()=>{const url=normalizeRelayUrl(document.getElementById('url').value);if(url){change('/admin/api/relays',{url});document.getElementById('url').value=''}};document.getElementById('save-settings').onclick=saveSettings;document.getElementById('url').addEventListener('blur',e=>{e.target.value=normalizeRelayUrl(e.target.value)});document.getElementById('ws').textContent=location.origin.replace(/^http/,'ws')+'/';document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(document.getElementById('ws').textContent);document.getElementById('copy').textContent='已复制'};document.getElementById('logout').onclick=async()=>{await fetch('/admin/api/logout',{method:'POST'});location.href='/admin'};refresh();</script></body></html>`;
