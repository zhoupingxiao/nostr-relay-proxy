import test from "node:test";
import assert from "node:assert/strict";
import worker, { RelayHub } from "../src/index.js";

function mockState(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    writes,
    storage: {
      async get(key) { return values.get(key); },
      async put(key, value) { writes.push(key); values.set(key, value); }
    }
  };
}

test("health endpoint is available without Durable Object bindings", async () => {
  const response = await worker.fetch(new Request("https://relay.example/health"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "nostr-relay-proxy");
  assert.equal(typeof body.time, "number");
});

test("homepage is available without Durable Object bindings and is never cached", async () => {
  const response = await worker.fetch(new Request("https://relay.example/"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(await response.text(), /renderUnavailable/);
});

test("missing admin variables fail closed with an actionable response", async () => {
  const response = await worker.fetch(new Request("https://relay.example/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password" })
  }), {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ADMIN_USER/);
});

test("RelayHub persists settings and normalizes access users", async () => {
  const state = mockState();
  const hub = new RelayHub(state, {});
  const response = await hub.fetch(new Request("https://relay/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Test relay",
      accessMode: "whitelist",
      accessUsers: [`${"a".repeat(64)} | Alice`]
    })
  }));
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.equal(settings.name, "Test relay");
  assert.equal(settings.accessMode, "whitelist");
  assert.deepEqual(settings.accessUsers, [{ pubkey: "a".repeat(64), name: "Alice" }]);
  assert.ok(state.writes.includes("settings"));
});

test("REQ without an available upstream is closed immediately", async () => {
  const state = mockState();
  const hub = new RelayHub(state, {});
  await hub.load();
  const sent = [];
  hub.clients.set("client", {
    id: "client",
    ws: { send(value) { sent.push(JSON.parse(value)); } },
    subscriptions: new Map(), counts: new Map(), negentropy: new Map(), seen: new Map(),
    authenticatedPubkeys: new Set(), authChallenge: "challenge", authChallengeSent: false,
    relayHost: "relay.example", createdAt: Date.now()
  });
  await hub.onClientMessage("client", JSON.stringify(["REQ", "sub", { kinds: [1] }]));
  assert.deepEqual(sent, [["CLOSED", "sub", "error: no upstream relay available"]]);
});

test("storage failures back off instead of retrying on every traffic message", async () => {
  let writes = 0;
  const state = {
    storage: {
      async get() { return undefined; },
      async put() { writes++; throw new Error("storage unavailable"); }
    }
  };
  const hub = new RelayHub(state, {});
  hub.loaded = true;
  hub.lastPersistAt = 0;
  for (let i = 0; i < 20; i++) hub.recordTraffic("upload", "client", "[\"REQ\"]", ["REQ"]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(writes, 1);
  assert.ok(hub.persistRetryAt > Date.now());
});

test("NIP-11 remains available when Durable Object dispatch fails", async () => {
  const env = {
    RELAY: {
      idFromName() { return "global"; },
      get() { return { fetch() { throw new Error("DO overloaded"); } }; }
    }
  };
  const response = await worker.fetch(new Request("https://relay.example/metadata", {
    headers: { accept: "application/nostr+json" }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-relay-degraded"), "1");
  assert.deepEqual((await response.json()).supported_nips, [1, 11, 42, 45, 77]);
});

test("public status returns a degraded snapshot when Durable Object is down", async () => {
  globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
  const env = {
    RELAY: {
      idFromName() { return "global"; },
      get() { return { fetch() { throw new Error("DO unavailable"); } }; }
    }
  };
  const response = await worker.fetch(new Request("https://relay.example/status"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-relay-degraded"), "1");
  assert.equal((await response.json()).degraded, true);
});
