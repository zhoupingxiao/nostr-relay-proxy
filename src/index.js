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
  } else if (type === "REQ") {
    item.subscription = String(msg?.[1] || "");
    item.filters = Math.max(0, msg.length - 2);
  } else if (type === "CLOSE" || type === "EOSE" || type === "CLOSED") {
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
    pubkey: typeof env.RELAY_PUBKEY === "string" ? env.RELAY_PUBKEY : "",
    contact: typeof env.RELAY_CONTACT === "string" ? env.RELAY_CONTACT : "",
    icon: typeof env.RELAY_ICON === "string" ? env.RELAY_ICON : "",
    software: "https://github.com/zhoupingxiao/nostr-relay-proxy",
    version: "1.0.0",
    supported_nips: parseNips(typeof env.RELAY_SUPPORTED_NIPS === "string" ? env.RELAY_SUPPORTED_NIPS : "1,11")
  };
}

function parseNips(value) {
  if (Array.isArray(value)) return value.map(x => Number(x)).filter(Number.isFinite);
  return String(value || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => Number(x))
    .filter(Number.isFinite);
}

function normalizeSettings(input, env) {
  const base = defaultSettings(env);
  const nips = parseNips(input?.supported_nips);
  return {
    name: String(input?.name || base.name).trim() || base.name,
    description: String(input?.description || "").trim() || base.description,
    pubkey: String(input?.pubkey || "").trim(),
    contact: String(input?.contact || "").trim(),
    icon: String(input?.icon || "").trim(),
    software: String(input?.software || base.software).trim() || base.software,
    version: String(input?.version || base.version).trim() || base.version,
    supported_nips: nips.length ? nips : base.supported_nips
  };
}

function adminPage() {
  return new Response(ADMIN_HTML, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
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
        const id = env.RELAY.idFromName("global");
        return env.RELAY.get(id).fetch(request);
      }
      if (request.headers.get("accept")?.includes("application/nostr+json")) {
        const id = env.RELAY.idFromName("global");
        return env.RELAY.get(id).fetch("https://relay/nip11");
      }
      if (request.headers.get("accept")?.includes("application/json")) {
        return json({ name: "nostr-relay-proxy", websocket: relayUrl(request), status: `${url.origin}/status`, admin: `${url.origin}/admin` });
      }
      return new Response(HOME_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/status") {
      const id = env.RELAY.idFromName("global");
      return env.RELAY.get(id).fetch("https://relay/public-status");
    }

    if (url.pathname === "/nip11") {
      const id = env.RELAY.idFromName("global");
      return env.RELAY.get(id).fetch("https://relay/nip11");
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
        return stub.fetch(new Request("https://relay/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text()
        }));
      }

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
      uploadedMessages: 0, downloadedMessages: 0, uploadedBytes: 0, downloadedBytes: 0,
      errors: 0
    };
    this.recentTraffic = [];
    this.lastPersistAt = 0;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.relays = (await this.state.storage.get("relays") || configuredRelays(this.env))
      .map(r => relayState(r.url, r));
    this.settings = normalizeSettings(await this.state.storage.get("settings"), this.env);
    this.stats = { ...this.stats, ...(await this.state.storage.get("stats") || {}) };
    this.recentTraffic = await this.state.storage.get("recentTraffic") || [];
    if (!this.stats.startedAt) {
      this.stats.startedAt = Date.now();
      await this.state.storage.put("stats", this.stats);
    }
    this.loaded = true;
    for (const r of this.relays.filter(x => x.enabled)) this.connectUpstream(r.url);
  }

  async persist() {
    await this.state.storage.put("relays", this.relays);
    await this.state.storage.put("settings", this.settings);
    await this.state.storage.put("stats", this.stats);
    await this.state.storage.put("recentTraffic", this.recentTraffic);
    this.lastPersistAt = Date.now();
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
    this.recentTraffic.unshift(entry);
    this.recentTraffic = this.recentTraffic.slice(0, 60);
    if (Date.now() - this.lastPersistAt > 10000) this.persist().catch(() => {});
  }

  async fetch(request) {
    try {
      return await this.handleFetch(request);
    } catch (error) {
      this.stats.errors = (this.stats.errors || 0) + 1;
      this.stats.lastError = errorMessage(error);
      this.persist().catch(() => {});
      return json({ error: "durable object error", message: this.stats.lastError }, 500);
    }
  }

  async handleFetch(request) {
    await this.load();
    const url = new URL(request.url);
    const clientSubscriptions = [...this.clients.values()].reduce((n, c) => n + c.subscriptions.size, 0);
    const upstreamSubscriptions = [...this.upstreams.values()].reduce((n, u) => n + u.routes.size, 0);

    if (url.pathname === "/status") return json({
      stats: this.stats,
      settings: this.settings,
      clients: this.clients.size,
      subscriptions: clientSubscriptions,
      clientSubscriptions,
      upstreamSubscriptions,
      relays: this.relays,
      traffic: this.recentTraffic
    });

    if (url.pathname === "/public-status") return json({
      name: this.settings.name,
      settings: this.settings,
      online: this.relays.some(r => r.connected),
      clients: this.clients.size,
      subscriptions: clientSubscriptions,
      clientSubscriptions,
      upstreamSubscriptions,
      stats: this.stats,
      relays: this.relays.map(({ url, enabled, connected, reconnects, lastConnectedAt, latencyMs }) => ({ url, enabled, connected, reconnects, lastConnectedAt, latencyMs }))
    }, 200, { "access-control-allow-origin": "*", "cache-control": "no-store" });

    if (url.pathname === "/nip11") {
      return new Response(JSON.stringify(this.settings), {
        headers: nip11Headers()
      });
    }

    if (url.pathname === "/settings" && request.method === "GET")
      return json(this.settings);

    if (url.pathname === "/settings" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      this.settings = normalizeSettings(body, this.env);
      await this.persist();
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
    this.recordTraffic("upload", "client", raw, msg);
    const type = msg[0];

    if (type === "EVENT") {
      const event = msg[1];
      if (!event?.id) return this.send(c, ["NOTICE", "invalid EVENT"]);
      this.stats.events++;
      this.stats.forwarded++;
      let ok = false;
      for (const u of this.upstreams.values()) {
        if (!u.ws || u.ws.readyState !== WebSocket.OPEN) continue;
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

    const startedAt = Date.now();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      item.connected = false;
      item.lastError = errorMessage(error);
      this.stats.errors = (this.stats.errors || 0) + 1;
      this.persist().catch(() => {});
      return;
    }
    const u = {
      url, ws, routes: new Map(), connecting: true, reconnectTimer: null,
      backoff: Math.min((existing?.backoff || 1000) * 2, 30000)
    };
    this.upstreams.set(url, u);

    ws.addEventListener("open", () => {
      u.connecting = false;
      u.backoff = 1000;
      item.connected = true;
      item.lastConnectedAt = Date.now();
      item.latencyMs = Math.max(0, Date.now() - startedAt);
      item.lastLatencyAt = Date.now();
      item.lastError = null;
      this.persist().catch(error => {
        this.stats.errors = (this.stats.errors || 0) + 1;
        this.stats.lastError = errorMessage(error);
      });
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
      this.stats.errors = (this.stats.errors || 0) + 1;
      this.persist().catch(() => {});
    });
    ws.addEventListener("close", () => {
      item.connected = false;
      this.upstreams.delete(url);
      this.stats.reconnects++;
      item.reconnects = (item.reconnects || 0) + 1;
      this.persist().catch(() => {});
      if (item.enabled) {
        const delay = Math.min(u.backoff || 1000, 30000);
        try { setTimeout(() => this.connectUpstream(url), delay); } catch {}
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
    this.recordTraffic("download", url, raw, msg);

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

const BASE_STYLE = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#07111f;color:#edf5ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#193e6c 0,transparent 33rem),radial-gradient(circle at 90% 5%,#123c38 0,transparent 28rem),#07111f;min-height:100vh}a{color:inherit}.shell{max-width:1120px;margin:auto;padding:32px 20px 56px}.admin-shell{max-width:1480px}.brand{display:flex;align-items:center;gap:12px;font-weight:750;letter-spacing:-.03em}.mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,#6ee7d6,#5797ff);color:#07111f;font-size:21px}.nav{display:flex;justify-content:space-between;align-items:center;gap:16px}.eyebrow{color:#7de5d6;text-transform:uppercase;letter-spacing:.13em;font-size:12px;font-weight:750}.hero{padding:82px 0 48px;max-width:760px}.admin-hero{padding:38px 0 22px;max-width:820px}.hero h1{font-size:clamp(38px,7vw,68px);letter-spacing:-.065em;line-height:1.02;margin:16px 0}.admin-hero h1{font-size:clamp(30px,4vw,46px)!important;margin:10px 0}.lead{font-size:18px;color:#b4c4d8;line-height:1.65;max-width:650px}.admin-hero .lead{font-size:15px;line-height:1.55}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.button{border:1px solid #45668e;border-radius:12px;padding:11px 15px;background:#10233c;color:#f4f8ff;font-weight:700;cursor:pointer;text-decoration:none;font:inherit}.button.primary{background:linear-gradient(135deg,#69e1d0,#6094ff);color:#07111f;border:0}.button.danger{background:#3a1823;border-color:#733448}.button:hover{filter:brightness(1.12)}.panel{background:linear-gradient(135deg,#10233cbb,#0d1b2dcc);border:1px solid #26486e;border-radius:20px;box-shadow:0 22px 60px #0004}.status-bar{display:flex;gap:10px;align-items:center;color:#b9cbe0;font-size:14px}.dot{width:9px;height:9px;border-radius:50%;background:#fa7188;box-shadow:0 0 0 5px #fa718822}.dot.on{background:#66e3a3;box-shadow:0 0 0 5px #66e3a322}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.home-metrics{grid-template-columns:repeat(5,1fr)}.admin-shell .grid{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.metric{padding:18px}.admin-shell .metric{padding:13px}.metric .value{font-weight:780;font-size:30px;letter-spacing:-.05em}.admin-shell .metric .value{font-size:22px}.home-metrics .value{font-size:24px}.metric .label,.muted{font-size:13px;color:#a9bdd5}.section{margin-top:22px;padding:24px}.admin-shell .section{padding:18px}.section h2{font-size:20px;letter-spacing:-.03em;margin:0 0 6px}.relay-list{display:grid;gap:10px;margin-top:18px}.relay{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px;border-radius:13px;background:#07182b99;border:1px solid #254667}.relay-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;word-break:break-all}.badge{font-size:12px;padding:5px 9px;border-radius:999px;background:#26374b;color:#c7d5e7;white-space:nowrap}.badge.on{background:#103e32;color:#7ef0bd}.badge.off{background:#42212b;color:#ffb2c1}.copy{font:inherit;border:0;background:transparent;color:#90b9ff;cursor:pointer;padding:0}.admin-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:18px}.relay-admin-grid{grid-template-columns:minmax(0,3.2fr) minmax(280px,.8fr)}.form-row{display:flex;gap:10px;margin-top:18px}.form-row input{flex:1;min-width:0}.input{border:1px solid #345575;border-radius:12px;padding:12px 14px;background:#081727;color:#eef7ff;font:inherit}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;margin-top:14px}.table th,.table td{padding:14px 9px;text-align:left;border-bottom:1px solid #28445f;font-size:14px}.relay-panel .table th,.relay-panel .table td{padding:9px 8px;font-size:12px;white-space:nowrap}.table th{font-size:12px;color:#9db5d0;text-transform:uppercase;letter-spacing:.08em}.relay-panel .table th{font-size:11px}.table td:first-child{word-break:break-all;min-width:240px}.relay-panel .table td:first-child{min-width:320px;white-space:normal}.mini{padding:7px 10px;border-radius:9px;font-size:12px}.relay-panel .mini{padding:5px 8px}.notice{display:none;margin-top:12px;color:#ffb5c3;font-size:14px}.login{max-width:430px;margin:10vh auto;padding:30px}.login h1{letter-spacing:-.04em;margin:18px 0 8px}.login form{display:grid;gap:12px;margin-top:24px}.login .button{width:100%}@media(max-width:900px){.home-metrics{grid-template-columns:repeat(2,1fr)}.admin-shell .grid{grid-template-columns:repeat(2,1fr)}.relay-admin-grid{grid-template-columns:1fr}}@media(max-width:720px){.shell{padding:22px 15px}.hero{padding:58px 0 35px}.admin-hero{padding:34px 0 18px}.grid{grid-template-columns:repeat(2,1fr)}.admin-grid{grid-template-columns:1fr}.relay{align-items:flex-start;flex-direction:column}.form-row{flex-direction:column}.form-row .button{width:100%}}
`;

const HOME_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nostr Relay Proxy</title><style>${BASE_STYLE}</style></head><body><main class="shell"><nav class="nav"><div class="brand"><span class="mark">ϟ</span>Nostr Relay Proxy</div><a class="button" href="/admin">管理后台</a></nav><section class="hero"><div class="eyebrow">Multi-relay gateway</div><h1>一个更可靠的<br> Nostr 连接入口。</h1><p class="lead">聚合多个上游 Relay，为你的客户端提供统一、稳定的 WebSocket 连接。状态实时更新，无需刷新页面。</p><div class="actions"><button class="button primary" id="copy">复制连接地址</button></div></section><section class="panel section"><div class="status-bar"><span id="dot" class="dot"></span><span id="summary">正在获取网络状态…</span><span class="muted" id="updated"></span></div><div class="grid home-metrics" id="metrics" style="margin-top:20px"></div></section><section class="panel section"><h2>上游 Relay</h2><p class="muted">已连接的上游会自动同步订阅；离线节点会采用退避策略重连。</p><div class="relay-list" id="relays"><div class="muted">加载中…</div></div></section></main><script>
const wsUrl=location.origin.replace(/^http/,'ws')+'/';document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(wsUrl);document.getElementById('copy').textContent='已复制 '+wsUrl;setTimeout(()=>document.getElementById('copy').textContent='复制连接地址',1800)};
const ago=n=>{if(!n)return '—';let s=Math.max(0,Math.floor((Date.now()-n)/1000));let h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h? h+' 小时 '+m+' 分钟':m?m+' 分钟':'刚刚'};
function metric(label,value){let el=document.createElement('div');el.className='metric panel';el.innerHTML='<div class="value"></div><div class="label"></div>';el.children[0].textContent=value;el.children[1].textContent=label;return el}
async function refresh(){try{const r=await fetch('/status',{cache:'no-store'});const s=await r.json();const active=s.relays.filter(x=>x.connected).length;const dot=document.getElementById('dot');dot.className='dot '+(s.online?'on':'');document.getElementById('summary').textContent=s.online?'服务在线 · '+active+' 个上游已连接':'正在等待上游 Relay 连接';document.getElementById('updated').textContent='更新于 '+new Date().toLocaleTimeString();const metrics=document.getElementById('metrics');metrics.replaceChildren(metric('在线用户',s.clients),metric('客户端活跃订阅',s.clientSubscriptions??s.subscriptions),metric('上游活跃订阅',s.upstreamSubscriptions??0),metric('可用 Relay',active+' / '+s.relays.length),metric('服务运行',ago(s.stats.startedAt)));const list=document.getElementById('relays');list.replaceChildren(...s.relays.map(x=>{let row=document.createElement('div');row.className='relay';let left=document.createElement('div');let name=document.createElement('div');name.className='relay-name';name.textContent=x.url;let meta=document.createElement('div');meta.className='muted';meta.textContent=x.connected?'已连接 '+ago(x.lastConnectedAt):x.enabled?'等待重连 · 已重连 '+x.reconnects+' 次':'已由管理员停用';left.append(name,meta);let badge=document.createElement('span');badge.className='badge '+(x.connected?'on':'off');badge.textContent=x.connected?'在线':'离线';row.append(left,badge);return row}));}catch{document.getElementById('summary').textContent='暂时无法读取状态';}}
refresh();setInterval(refresh,5000);</script></body></html>`;

const LOGIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · Nostr Relay Proxy</title><style>${BASE_STYLE}</style></head><body><main class="shell"><div class="panel login"><div class="brand"><span class="mark">ϟ</span>Nostr Relay Proxy</div><h1>欢迎回来</h1><p class="muted">登录后管理上游 Relay 与实时网络状态。</p><form id="form"><input class="input" id="username" autocomplete="username" placeholder="管理员用户名" required><input class="input" id="password" type="password" autocomplete="current-password" placeholder="密码" required><button class="button primary" id="submit">安全登录</button><div class="notice" id="notice">__ERROR__</div></form></div></main><script>document.getElementById('form').onsubmit=async e=>{e.preventDefault();const b=document.getElementById('submit');b.disabled=true;b.textContent='登录中…';const user=document.getElementById('username').value;const pass=document.getElementById('password').value;const r=await fetch('/admin/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:user,password:pass})});if(r.ok){location.href='/admin';return}const d=await r.json().catch(()=>({error:'登录失败'}));const n=document.getElementById('notice');n.textContent=d.error||'登录失败';n.style.display='block';b.disabled=false;b.textContent='安全登录'}</script></body></html>`;

const ADMIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理后台 · Nostr Relay Proxy</title><style>${BASE_STYLE}</style></head><body><main class="shell admin-shell"><nav class="nav"><div class="brand"><span class="mark">ϟ</span>Nostr Relay Proxy <span class="badge on">管理后台</span></div><div class="actions" style="margin:0"><a class="button" href="/">查看前台</a><button class="button" id="logout">退出</button></div></nav><section class="hero admin-hero"><div class="eyebrow">Control center</div><h1>Relay 网络控制台</h1><p class="lead">实时查看连接、流量与上游健康状态。更改会立即应用到当前网关。</p></section><div class="grid" id="metrics"></div><section class="admin-grid relay-admin-grid" style="margin-top:18px"><div class="panel section relay-panel"><h2>上游 Relay</h2><p class="muted">启用后立即连接；停用不会删除配置。</p><div class="form-row"><input class="input" id="url" placeholder="relay.example.com" aria-label="Relay 地址"><button class="button primary" id="add">添加 Relay</button></div><div class="notice" id="notice"></div><div class="table-wrap"><table class="table"><thead><tr><th>地址</th><th>状态</th><th>延迟</th><th>连接时长</th><th>转发</th><th>下载</th><th>上传</th><th>下载量</th><th>重连</th><th>最后错误</th><th>操作</th></tr></thead><tbody id="relays"></tbody></table></div></div><aside class="panel section"><h2>连接信息</h2><p class="muted">将以下地址填入 Nostr 客户端。</p><div class="relay-name" id="ws"></div><button class="copy" id="copy" style="margin-top:10px">复制 WebSocket 地址</button><hr style="border:0;border-top:1px solid #28445f;margin:24px 0"><div class="muted">服务运行时间</div><div class="value" style="font-size:25px;margin-top:6px" id="uptime">—</div><hr style="border:0;border-top:1px solid #28445f;margin:22px 0"><h2>中继资料</h2><div class="form-row" style="flex-direction:column"><input class="input" id="set-name" placeholder="中继名称"><input class="input" id="set-desc" placeholder="描述"><input class="input" id="set-pubkey" placeholder="机主公钥 hex"><input class="input" id="set-contact" placeholder="联系方式，例如 mailto:you@example.com"><input class="input" id="set-icon" placeholder="头像 URL"><input class="input" id="set-nips" placeholder="支持的 NIPs，例如 1,11,42"><button class="button primary" id="save-settings">保存资料</button></div><div class="notice" id="settings-notice"></div><div class="muted" style="margin-top:20px">提示：上游列表和中继资料都保存在 Durable Object；Cloudflare 中的变量仅用于首次默认值。</div></aside></section><section class="panel section"><h2>最近流量</h2><p class="muted">展示客户端上传与上游返回的消息摘要，不直接展开完整事件内容。</p><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>方向</th><th>类型</th><th>来源</th><th>数据</th><th>大小</th></tr></thead><tbody id="traffic"></tbody></table></div></section></main><script>
const elapsed=n=>{if(!n)return '—';let s=Math.floor((Date.now()-n)/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60);if(h)return h+'小时 '+m+'分';if(m)return m+'分 '+(s%60)+'秒';return s+'秒'};const size=n=>n>1048576?(n/1048576).toFixed(1)+' MB':n>1024?(n/1024).toFixed(1)+' KB':(n||0)+' B';const api=async(p,o)=>{const r=await fetch(p,o);if(r.status===401){location.href='/admin';throw Error('unauthorized')}const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'请求失败');return d};let settingsLoaded=false;function card(label,value){let e=document.createElement('div');e.className='metric panel';e.innerHTML='<div class="value"></div><div class="label"></div>';e.children[0].textContent=value;e.children[1].textContent=label;return e}function show(msg){const n=document.getElementById('notice');n.textContent=msg;n.style.display=msg?'block':'none'}function showSettings(msg,ok=true){const n=document.getElementById('settings-notice');n.textContent=msg;n.style.display=msg?'block':'none';n.style.color=ok?'#7ef0bd':'#ffb5c3'}function normalizeRelayUrl(v){v=v.trim();if(!v)return '';const lower=v.toLowerCase();if(lower.startsWith('wss://'))return 'wss://'+v.slice(6);if(lower.startsWith('ws://'))return 'ws://'+v.slice(5);if(v.includes('://'))return v;return 'wss://'+v}function trafficText(t){if(t.eventId)return 'event '+t.eventId.slice(0,12)+(t.kind!==null&&t.kind!==undefined?' · kind '+t.kind:'');if(t.subscription)return 'sub '+t.subscription+(t.filters?' · '+t.filters+' filters':'');if(t.ok!==undefined)return t.ok?'OK':'failed';return '—'}function fillSettings(s,force=false){if(!s||!force&&settingsLoaded&&document.activeElement?.id?.startsWith('set-'))return;settingsLoaded=true;document.getElementById('set-name').value=s.name||'';document.getElementById('set-desc').value=s.description||'';document.getElementById('set-pubkey').value=s.pubkey||'';document.getElementById('set-contact').value=s.contact||'';document.getElementById('set-icon').value=s.icon||'';document.getElementById('set-nips').value=(s.supported_nips||[]).join(',')}
async function refresh(){try{const s=await api('/admin/api/status');document.getElementById('metrics').replaceChildren(card('在线用户',s.clients),card('客户端活跃订阅',s.clientSubscriptions??s.subscriptions),card('上游活跃订阅',s.upstreamSubscriptions??0),card('上传流量',size(s.stats.uploadedBytes)),card('下载流量',size(s.stats.downloadedBytes)),card('客户端事件',s.stats.events),card('内部错误',s.stats.errors||0),card('可用上游',s.relays.filter(x=>x.connected).length+' / '+s.relays.length));fillSettings(s.settings);document.getElementById('uptime').textContent=elapsed(s.stats.startedAt);const tbody=document.getElementById('relays');tbody.replaceChildren(...s.relays.map(r=>{const tr=document.createElement('tr');const values=[r.url,r.connected?'在线':r.enabled?'离线':'已停用',r.latencyMs!==null&&r.latencyMs!==undefined?r.latencyMs+' ms':'—',r.connected?elapsed(r.lastConnectedAt):'—',r.forwardedEvents||0,r.downloadedEvents||0,size(r.uploadedBytes),size(r.downloadedBytes),r.reconnects||0,r.lastError||'—'];values.forEach((v,i)=>{const td=document.createElement('td');td.textContent=v;if(i===1)td.className=r.connected?'badge on':'badge off';tr.append(td)});const actions=document.createElement('td');const toggle=document.createElement('button');toggle.className='button mini';toggle.textContent=r.enabled?'停用':'启用';toggle.onclick=()=>change('/admin/api/relays/toggle',{url:r.url,enabled:!r.enabled});const del=document.createElement('button');del.className='button danger mini';del.style.marginLeft='6px';del.textContent='删除';del.onclick=()=>{if(confirm('删除 '+r.url+'？'))change('/admin/api/relays',{url:r.url},'DELETE')};actions.append(toggle,del);tr.append(actions);return tr}));const traffic=document.getElementById('traffic');traffic.replaceChildren(...(s.traffic||[]).map(t=>{const tr=document.createElement('tr');[new Date(t.at).toLocaleTimeString(),t.direction==='upload'?'上传':'下载',t.type,t.source,trafficText(t),size(t.bytes)].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.append(td)});return tr}));show(s.stats.lastError?'最近内部错误：'+s.stats.lastError:'')}catch(e){show(e.message)}}async function change(path,body,method='POST'){try{await api(path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});refresh()}catch(e){show(e.message)}}async function saveSettings(){const b=document.getElementById('save-settings');b.disabled=true;b.textContent='保存中…';showSettings('正在保存…');try{const saved=await api('/admin/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.getElementById('set-name').value,description:document.getElementById('set-desc').value,pubkey:document.getElementById('set-pubkey').value,contact:document.getElementById('set-contact').value,icon:document.getElementById('set-icon').value,supported_nips:document.getElementById('set-nips').value})});fillSettings(saved,true);showSettings('已保存中继资料');setTimeout(()=>showSettings(''),2200)}catch(e){showSettings(e.message||'保存失败',false)}finally{b.disabled=false;b.textContent='保存资料'}}document.getElementById('add').onclick=()=>{const url=normalizeRelayUrl(document.getElementById('url').value);if(url){change('/admin/api/relays',{url});document.getElementById('url').value=''}};document.getElementById('save-settings').onclick=saveSettings;document.getElementById('url').addEventListener('blur',e=>{e.target.value=normalizeRelayUrl(e.target.value)});document.getElementById('ws').textContent=location.origin.replace(/^http/,'ws')+'/';document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(document.getElementById('ws').textContent);document.getElementById('copy').textContent='已复制'};document.getElementById('logout').onclick=async()=>{await fetch('/admin/api/logout',{method:'POST'});location.href='/admin'};refresh();setInterval(refresh,5000);</script></body></html>`;
