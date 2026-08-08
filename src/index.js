function configuredRelays(env) {
  // This binding is configured in the Cloudflare dashboard. It seeds only a
  // brand-new Durable Object; subsequent changes belong in the admin UI.
  return (typeof env.UPSTREAM_RELAYS === "string" ? env.UPSTREAM_RELAYS : "")
    .split(",")
    .map(s => s.trim())
    .filter(isRelayUrl)
    .map(url => ({
      url,
      enabled: true,
      connected: false,
      reconnects: 0,
      lastError: null,
      lastConnectedAt: null
    }));
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function authOk(request, env) {
  const username = typeof env.ADMIN_USER === "string" ? env.ADMIN_USER : "";
  const password = typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";
  // A deployment must not inherit a usable default administrator account.
  if (!username || !password) return false;

  const h = request.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  try {
    const decoded = atob(h.slice(6));
    const i = decoded.indexOf(":");
    if (i < 0) return false;
    return decoded.slice(0, i) === username && decoded.slice(i + 1) === password;
  } catch { return false; }
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

function adminPage() {
  return new Response(ADMIN_HTML, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "nostr-relay-proxy", time: Date.now() });
    }

    if (url.pathname === "/") {
      return json({
        name: "nostr-relay-proxy",
        description: "Cloudflare Workers + Durable Objects multi-relay Nostr gateway",
        supported: ["EVENT", "REQ", "CLOSE", "NIP-11"],
        websocket: relayUrl(request),
        admin: `${url.origin}/admin`
      });
    }

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!authOk(request, env)) return unauthorized();
      if (url.pathname === "/admin") return adminPage();

      const id = env.RELAY.idFromName("global");
      const stub = env.RELAY.get(id);

      if (request.method === "GET" && url.pathname === "/admin/api/status")
        return stub.fetch("https://relay/status");

      if (request.method === "GET" && url.pathname === "/admin/api/relays")
        return stub.fetch("https://relay/relays");

      if (request.method === "POST" && url.pathname === "/admin/api/relays") {
        return stub.fetch(new Request("https://relay/relays", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text()
        }));
      }

      if (request.method === "DELETE" && url.pathname === "/admin/api/relays") {
        return stub.fetch(new Request("https://relay/relays", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: await request.text()
        }));
      }

      if (request.method === "POST" && url.pathname === "/admin/api/relays/toggle") {
        return stub.fetch(new Request("https://relay/relays/toggle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text()
        }));
      }

      return json({ error: "not found" }, 404);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const id = env.RELAY.idFromName("global");
      return env.RELAY.get(id).fetch(request);
    }

    if (request.headers.get("accept")?.includes("application/nostr+json")) {
      return new Response(JSON.stringify({
        name: "nostr-relay-proxy",
        description: "Multi-relay Nostr aggregation proxy",
        supported_nips: [1, 11]
      }), {
        headers: {
          "content-type": "application/nostr+json",
          "access-control-allow-origin": "*"
        }
      });
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
    this.stats = { events: 0, forwarded: 0, deduped: 0, connections: 0, reconnects: 0 };
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.relays = await this.state.storage.get("relays") || configuredRelays(this.env);
    this.stats = await this.state.storage.get("stats") || this.stats;
    this.loaded = true;
    for (const r of this.relays.filter(x => x.enabled)) this.connectUpstream(r.url);
  }

  async persist() {
    await this.state.storage.put("relays", this.relays);
    await this.state.storage.put("stats", this.stats);
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);

    if (url.pathname === "/status") return json({
      stats: this.stats,
      clients: this.clients.size,
      subscriptions: [...this.clients.values()].reduce((n, c) => n + c.subscriptions.size, 0),
      relays: this.relays
    });

    if (url.pathname === "/relays" && request.method === "GET")
      return json(this.relays);

    if (url.pathname === "/relays" && request.method === "POST") {
      const body = await request.json();
      const relay = String(body.url || "").trim();
      if (!isRelayUrl(relay)) return json({ error: "invalid relay url" }, 400);
      if (!this.relays.some(r => r.url === relay)) {
        const item = { url: relay, enabled: true, connected: false, reconnects: 0, lastError: null, lastConnectedAt: null };
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
      ws: server,
      subscriptions: new Map(),
      seen: new Map(),
      createdAt: Date.now()
    };
    this.clients.set(clientId, state);
    this.stats.connections++;

    server.accept();
    server.serializeAttachment({ clientId });
    server.addEventListener("message", e => this.onClientMessage(clientId, e.data));
    server.addEventListener("close", () => this.clients.delete(clientId));
    server.addEventListener("error", () => this.clients.delete(clientId));

    return new Response(null, { status: 101, webSocket: client });
  }

  async onClientMessage(clientId, raw) {
    const c = this.clients.get(clientId);
    if (!c || typeof raw !== "string") return;
    let msg;
    try { msg = JSON.parse(raw); } catch {
      try { c.ws.send(JSON.stringify(["NOTICE", "invalid JSON"])); } catch {}
      return;
    }
    if (!Array.isArray(msg) || !msg[0]) return;
    const type = msg[0];

    if (type === "EVENT") {
      const event = msg[1];
      if (!event?.id) return this.send(c, ["NOTICE", "invalid EVENT"]);
      this.stats.events++;
      this.stats.forwarded++;
      let ok = false;
      for (const u of this.upstreams.values()) {
        if (!u.ws || u.ws.readyState !== WebSocket.OPEN) continue;
        try { u.ws.send(JSON.stringify(["EVENT", event])); ok = true; } catch {}
      }
      this.send(c, ["OK", event.id, ok, ok ? "forwarded" : "no upstream relay available"]);
      return;
    }

    if (type === "REQ") {
      const subId = String(msg[1] || "");
      const filters = msg.slice(2);
      if (!subId || !filters.length) return;
      c.subscriptions.set(subId, { filters, upstreamIds: new Map() });
      for (const u of this.upstreams.values()) {
        if (!u.ws || u.ws.readyState !== WebSocket.OPEN) continue;
        const upstreamId = `${clientId}:${subId}:${crypto.randomUUID().slice(0,8)}`;
        c.subscriptions.get(subId).upstreamIds.set(u.url, upstreamId);
        u.routes.set(upstreamId, { clientId, subId });
        try { u.ws.send(JSON.stringify(["REQ", upstreamId, ...filters])); } catch {}
      }
      return;
    }

    if (type === "CLOSE") {
      const subId = String(msg[1] || "");
      const sub = c.subscriptions.get(subId);
      if (!sub) return;
      for (const [url, upstreamId] of sub.upstreamIds) {
        const u = this.upstreams.get(url);
        if (u) {
          u.routes.delete(upstreamId);
          if (u.ws?.readyState === WebSocket.OPEN)
            try { u.ws.send(JSON.stringify(["CLOSE", upstreamId])); } catch {}
        }
      }
      c.subscriptions.delete(subId);
    }
  }

  connectUpstream(url) {
    const existing = this.upstreams.get(url);
    if (existing?.connecting || existing?.ws?.readyState === WebSocket.OPEN) return;
    const item = this.relays.find(r => r.url === url);
    if (!item?.enabled) return;

    const ws = new WebSocket(url);
    const u = {
      url, ws, routes: new Map(), connecting: true, reconnectTimer: null,
      backoff: Math.min((existing?.backoff || 1000) * 2, 30000)
    };
    this.upstreams.set(url, u);

    ws.addEventListener("open", async () => {
      u.connecting = false;
      u.backoff = 1000;
      item.connected = true;
      item.lastConnectedAt = Date.now();
      item.lastError = null;
      await this.persist();
      for (const c of this.clients.values()) {
        for (const [subId, sub] of c.subscriptions) {
          const upstreamId = `${crypto.randomUUID()}`;
          sub.upstreamIds.set(url, upstreamId);
          u.routes.set(upstreamId, { clientId: this.findClientId(c), subId });
          try { ws.send(JSON.stringify(["REQ", upstreamId, ...sub.filters])); } catch {}
        }
      }
    });

    ws.addEventListener("message", e => this.onUpstreamMessage(url, e.data));
    ws.addEventListener("error", () => {
      item.lastError = "upstream websocket error";
    });
    ws.addEventListener("close", () => {
      item.connected = false;
      this.upstreams.delete(url);
      this.stats.reconnects++;
      item.reconnects = (item.reconnects || 0) + 1;
      this.persist();
      if (item.enabled) {
        const delay = Math.min(u.backoff || 1000, 30000);
        setTimeout(() => this.connectUpstream(url), delay);
      }
    });
  }

  findClientId(clientState) {
    for (const [id, c] of this.clients) if (c === clientState) return id;
    return null;
  }

  onUpstreamMessage(url, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg) || !msg[0]) return;
    const u = this.upstreams.get(url);
    if (!u) return;

    if (msg[0] === "EVENT" && msg[1]) {
      const upstreamId = String(msg[1]);
      const route = u.routes.get(upstreamId);
      if (!route) return;
      const c = this.clients.get(route.clientId);
      if (!c) return;
      const event = msg[2];
      const key = `${route.subId}:${event?.id}`;
      const now = Date.now();
      const old = c.seen.get(key);
      if (old && now - old < 60000) {
        this.stats.deduped++;
        return;
      }
      c.seen.set(key, now);
      this.send(c, ["EVENT", route.subId, event]);
      if (c.seen.size > 5000) {
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

    if (msg[0] === "OK" || msg[0] === "NOTICE" || msg[0] === "CLOSED") {
      this.send(c, msg[0] === "OK" ? ["OK", ...msg.slice(1)] :
                    msg[0] === "CLOSED" ? ["CLOSED", route.subId, ...msg.slice(2)] :
                    ["NOTICE", ...msg.slice(1)]);
    }
  }

  send(c, msg) {
    try { c.ws.send(JSON.stringify(msg)); } catch {}
  }
}

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nostr Relay 管理后台</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1100px;margin:30px auto;padding:0 16px;background:#f5f6f8;color:#202124}
.card{background:#fff;border-radius:14px;padding:20px;margin:14px 0;box-shadow:0 2px 10px #0001}
h1{margin-top:0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{font-size:28px;font-weight:700}.muted{color:#666;font-size:13px}
input,button{padding:10px;border:1px solid #ddd;border-radius:8px}button{cursor:pointer;background:#111;color:#fff}
table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #eee;text-align:left}
.ok{color:#087f23}.bad{color:#b42318}.row{display:flex;gap:8px;flex-wrap:wrap}
</style></head><body>
<h1>Nostr Relay 管理后台</h1>
<div class="card"><div class="grid" id="stats"></div></div>
<div class="card"><h2>上游 Relay</h2>
<div class="row"><input id="url" placeholder="wss://relay.example.com" style="flex:1"><button onclick="addRelay()">添加</button></div>
<table><thead><tr><th>Relay</th><th>状态</th><th>重连</th><th>操作</th></tr></thead><tbody id="relays"></tbody></table></div>
<div class="card"><p class="muted">WebSocket Relay 地址：<code id="ws"></code></p></div>
<script>
async function api(path,opt){const r=await fetch(path,opt);return r.json()}
async function refresh(){
 const s=await api('/admin/api/status');
 document.getElementById('stats').innerHTML=[
 ['在线连接',s.clients],['订阅',s.subscriptions],['EVENT',s.stats.events],['转发',s.stats.forwarded],['去重',s.stats.deduped],['重连',s.stats.reconnects]
 ].map(x=>'<div><div class="stat">'+x[1]+'</div><div class="muted">'+x[0]+'</div></div>').join('');
 document.getElementById('relays').innerHTML=s.relays.map(r=>'<tr><td>'+r.url+'</td><td class="'+(r.connected?'ok':'bad')+'">'+(r.connected?'在线':'离线')+'</td><td>'+r.reconnects+'</td><td><button onclick="toggleRelay('+JSON.stringify(r.url)+','+(!r.enabled)+')">'+(r.enabled?'停用':'启用')+'</button> <button onclick="delRelay('+JSON.stringify(r.url)+')">删除</button></td></tr>').join('');
 document.getElementById('ws').textContent=location.origin.replace(/^http/,'ws')+'/';
}
async function addRelay(){const u=document.getElementById('url').value.trim();if(!u)return;await api('/admin/api/relays',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:u})});document.getElementById('url').value='';refresh()}
async function delRelay(url){if(!confirm('删除 '+url+' ?'))return;await api('/admin/api/relays',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({url})});refresh()}
async function toggleRelay(url,enabled){await api('/admin/api/relays/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,enabled})});refresh()}
refresh();setInterval(refresh,5000);
</script></body></html>`;
