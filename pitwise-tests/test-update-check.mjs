// Test file=check v update.js (licencni brana v aplikaci; node --test). Mock globalThis.fetch emuluje Payhip v1; sleduje, zda se volal GitHub.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "./_build/update.mjs";

const realFetch = globalThis.fetch;
let githubCalled;
let payhipMode; // "valid" | "disabled" | "500" | "429" | "throw" | "normOnly" (platny jen "ABC-DEF")

beforeEach(() => {
  githubCalled = false;
  payhipMode = "valid";
  globalThis.fetch = async (input) => {
    const u = String(typeof input === "string" ? input : input.url);
    if (u.includes("api.github.com")) {
      githubCalled = true;
      return new Response("FILE", { status: 200 });
    }
    if (u.includes("payhip.com/api/v1/license/verify")) {
      if (payhipMode === "500") return new Response("err", { status: 500 });
      if (payhipMode === "429") return new Response("slow down", { status: 429 });
      if (payhipMode === "throw") throw new Error("network");
      if (payhipMode === "normOnly") {
        const ok = new URL(u).searchParams.get("license_key") === "ABC-DEF";
        return new Response(JSON.stringify({ data: { enabled: ok } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { enabled: payhipMode === "valid" } }), { status: 200 });
    }
    throw new Error("unexpected fetch " + u);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const call = (qs, env, ip) =>
  onRequest({ request: new Request("https://pitwise.net/api/update" + qs, ip ? { headers: { "CF-Connecting-IP": ip } } : {}), env });
const memKV = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const fullEnv = { PAYHIP_API_KEY: "pk", GH_TOKEN: "t", GH_REPO: "o/r" };

test("check + platny klic -> 200 {ok:true}, GitHub nevolan", async () => {
  const r = await call("?file=check&key=ABC", fullEnv);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(githubCalled, false);
});

test("check + neplatny klic -> 403", async () => {
  payhipMode = "disabled";
  const r = await call("?file=check&key=ABC", fullEnv);
  assert.equal(r.status, 403);
  assert.equal(githubCalled, false);
});

test("check + Payhip 500 -> 503", async () => {
  payhipMode = "500";
  const r = await call("?file=check&key=ABC", fullEnv);
  assert.equal(r.status, 503);
});

test("check bez klice -> 403", async () => {
  const r = await call("?file=check", fullEnv);
  assert.equal(r.status, 403);
});

test("check jen s PAYHIP_API_KEY (bez GH env) + platny -> 200", async () => {
  const r = await call("?file=check&key=ABC", { PAYHIP_API_KEY: "pk" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(githubCalled, false);
});

test("regrese: file=ps1 bez GH env -> 500 endpoint not configured", async () => {
  const r = await call("?file=ps1&key=ABC", { PAYHIP_API_KEY: "pk" });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /endpoint not configured/);
});

test("check + maly/mezerovy klic platny az po normalizaci -> 200", async () => {
  payhipMode = "normOnly";
  const r = await call("?file=check&key=" + encodeURIComponent("abc- def"), fullEnv);
  assert.equal(r.status, 200);
});

test("check + Payhip 429 -> 503", async () => {
  payhipMode = "429";
  const r = await call("?file=check&key=ABC", fullEnv);
  assert.equal(r.status, 503);
});

test("check + fetch vyhodi -> 503", async () => {
  payhipMode = "throw";
  const r = await call("?file=check&key=ABC", fullEnv);
  assert.equal(r.status, 503);
});

test("rate limit: 21. check ze stejne IP -> 429", async () => {
  const env = { ...fullEnv, FEEDBACK: memKV() };
  for (let i = 0; i < 20; i++) assert.equal((await call("?file=check&key=ABC", env, "1.2.3.4")).status, 200);
  const r = await call("?file=check&key=ABC", env, "1.2.3.4");
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { ok: false, error: "too many attempts, try again later" });
  assert.equal((await call("?file=check&key=ABC", env, "5.6.7.8")).status, 200);
});

test("bez FEEDBACK vazby zadny limit", async () => {
  for (let i = 0; i < 25; i++) assert.equal((await call("?file=check&key=ABC", fullEnv, "1.2.3.4")).status, 200);
});
