// Test casove omezenych klicu: sprava /api/keys + overeni v /api/update (node --test). Payhip i GitHub mockovane.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { onRequest as keys } from "./_build/keys.mjs";
import { onRequest as update } from "./_build/update.mjs";

const realFetch = globalThis.fetch;
let payhipCalled, githubCalled;
beforeEach(() => {
  payhipCalled = githubCalled = false;
  globalThis.fetch = async (input) => {
    const u = String(typeof input === "string" ? input : input.url);
    if (u.includes("api.github.com")) { githubCalled = true; return new Response("FILE", { status: 200 }); }
    if (u.includes("payhip.com")) { payhipCalled = true; return new Response(JSON.stringify({ data: [] }), { status: 200 }); }
    throw new Error("unexpected fetch " + u);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const memKV = () => {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k).v : null),
    put: async (k, v, o) => { m.set(k, { v, metadata: o && o.metadata }); },
    list: async ({ prefix }) => ({ list_complete: true, keys: [...m].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })) }),
  };
};
const mkEnv = () => ({ ADMIN_TOKEN: "adm", PAYHIP_API_KEY: "pk", GH_TOKEN: "t", GH_REPO: "o/r", FEEDBACK: memKV() });
const admin = (env, method, body, tok = "adm") => keys({ env, request: new Request("https://pitwise.net/api/keys?token=" + tok, { method, body: body ? JSON.stringify(body) : undefined }) });
const check = (env, key, extra = "&timed=1") => update({ env, request: new Request("https://pitwise.net/api/update?file=check&key=" + encodeURIComponent(key) + extra) });
const DAY = 86400000;
const create = async (env, exp = Date.now() + DAY) => (await (await admin(env, "POST", { exp, note: "test" })).json()).key;

test("bez spravneho tokenu -> 401 a nic se nevytvori", async () => {
  const env = mkEnv();
  assert.equal((await admin(env, "POST", { exp: Date.now() + DAY }, "bad")).status, 401);
  assert.equal((await admin(env, "GET", null, "bad")).status, 401);
  assert.deepEqual((await (await admin(env, "GET")).json()).items, []);
});

test("bez tokenu, s prazdnym i spatnym -> 401 pro seznam, vytvoreni i zmenu; klic beze zmeny", async () => {
  const env = mkEnv(), exp = Date.now() + DAY;
  const k = await create(env, exp);
  const before = await (await admin(env, "GET")).json();
  for (const qs of ["", "?token=", "?token=bad", "?token=ADM", "?token=adm2"]) {
    const req = (method, body) => keys({ env, request: new Request("https://pitwise.net/api/keys" + qs, { method, body: body ? JSON.stringify(body) : undefined }) });
    assert.equal((await req("GET")).status, 401, "GET " + qs);
    assert.equal((await req("POST", { exp })).status, 401, "POST " + qs);
    assert.equal((await req("PUT", { key: k, exp: 1 })).status, 401, "PUT " + qs);
  }
  assert.deepEqual(await (await admin(env, "GET")).json(), before);
  assert.equal((await check(env, k)).status, 200);
});

test("ADMIN_TOKEN na serveru nenastaveny -> 401 i s prazdnym tokenem", async () => {
  const env = mkEnv();
  delete env.ADMIN_TOKEN;
  assert.equal((await keys({ env, request: new Request("https://pitwise.net/api/keys?token=", { method: "POST", body: JSON.stringify({ exp: Date.now() + DAY }) }) })).status, 401);
});

test("novy klic ma tvar PWT-XXXXX-XXXXX-XXXXX a je v seznamu s datem i poznamkou", async () => {
  const env = mkEnv(), exp = Date.now() + DAY;
  const k = await create(env, exp);
  assert.match(k, /^PWT-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const it = (await (await admin(env, "GET")).json()).items[0];
  assert.equal(it.key, k); assert.equal(it.exp, exp); assert.equal(it.note, "test");
});

test("spatne exp -> 400 (text, minulost pri vytvoreni)", async () => {
  const env = mkEnv();
  assert.equal((await admin(env, "POST", { exp: "zitra" })).status, 400);
  assert.equal((await admin(env, "POST", { exp: Date.now() - 1000 })).status, 400);
});

test("platny klic -> 200 bez Payhipu; vyprseny -> 403", async () => {
  const env = mkEnv();
  const k = await create(env);
  assert.equal((await check(env, k)).status, 200);
  assert.equal(payhipCalled, false);
  assert.equal((await (await admin(env, "PUT", { key: k, exp: Date.now() - 1 })).json()).ok, true);
  assert.equal((await check(env, k)).status, 403);
});

test("expiraci jde i prodlouzit, poznamka zustane", async () => {
  const env = mkEnv();
  const k = await create(env);
  await admin(env, "PUT", { key: k, exp: Date.now() - 1 });
  const r = await (await admin(env, "PUT", { key: k, exp: Date.now() + DAY })).json();
  assert.equal(r.note, "test");
  assert.equal((await check(env, k)).status, 200);
});

test("PUT neznameho klice -> 404 a nic nevznikne", async () => {
  const env = mkEnv();
  assert.equal((await admin(env, "PUT", { key: "PWT-NOPE", exp: Date.now() + DAY })).status, 404);
  assert.equal((await check(env, "PWT-NOPE")).status, 403);
});

test("stara appka (check bez timed=1) -> 403, i s platnym klicem", async () => {
  const env = mkEnv();
  assert.equal((await check(env, await create(env), "")).status, 403);
});

test("mala pismena a mezery kolem klice projdou", async () => {
  const env = mkEnv();
  assert.equal((await check(env, "  " + (await create(env)).toLowerCase() + " ")).status, 200);
});

test("stazeni souboru: platny -> soubor; vyprseny -> 403 bez GitHubu; bez timed=1 jde (aktualizace stare appky)", async () => {
  const env = mkEnv();
  const k = await create(env);
  const dl = () => update({ env, request: new Request("https://pitwise.net/api/update?file=ps1&key=" + k) });
  assert.equal((await dl()).status, 200);
  assert.equal(githubCalled, true);
  githubCalled = false;
  await admin(env, "PUT", { key: k, exp: Date.now() - 1 });
  assert.equal((await dl()).status, 403);
  assert.equal(githubCalled, false);
});

test("vypadek KV -> 503, ne 'neplatny klic'", async () => {
  const env = mkEnv();
  env.FEEDBACK.get = async () => { throw new Error("kv down"); };
  assert.equal((await check(env, "PWT-AAAAA-AAAAA-AAAAA")).status, 503);
});

test("bez KV vazby -> 503", async () => {
  const env = mkEnv();
  delete env.FEEDBACK;
  assert.equal((await check(env, "PWT-AAAAA-AAAAA-AAAAA")).status, 503);
});

test("regrese: Payhip klic dal jde pres Payhip", async () => {
  const env = mkEnv();
  assert.equal((await check(env, "ABCDE-FGHIJ")).status, 403);
  assert.equal(payhipCalled, true);
});
