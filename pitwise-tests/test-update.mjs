// Testy /api/update: overeni licence u Payhipu (v2 product secret / v1 API key) + tridy valid/invalid/down/auth.
// Incident 17.-18.10.2026: pregenerovany Payhip API key -> v1 401 -> drive 403 "invalid license key" vsem zakaznikum.
// Vsechno mockovane: globalni fetch smeruje Payhip v1/v2, GitHub a Discord URL na lokalni handlery, KV je Map.
// Chovani Payhipu v mocku = ZMERENE 18.10.2026 (v1: 200 data:{} / 200 data:[] / 401; v2: 200 / 400 / 401).
import { onRequest as update } from "./_build/update.mjs";
import { onRequest as errlog } from "./_build/errlog.mjs";
import { onRequest as watchdog } from "./_build/watchdog.mjs";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK   " + m); } else { fail++; console.log("  FAIL " + m); } };

const GOOD = "ABCD-EFGH-IJKL-MNOP";          // platny klic zakaznika
const DISABLED = "DEAD-BEEF-0000-1111";      // refundovany klic (enabled:false)
const OTHER = "OTHR-PROD-0000-2222";         // platny klic, ale k jinemu produktu
const API = "acct_api_key_SECRET123";        // spravny API key uctu (v1)
const SECRET = "prod_sk_SECRET456";          // spravny product secret (v2)
const FILE = "PITWISE-FILE-BYTES";
const ZW = String.fromCharCode(0x200B);      // zero-width space (zamerne ne literal v souboru)

// KV mock: lag = latence v ms, failFlag = put na srvflag_* hazi (jako KV 429 pri >1 zapisu/s)
function makeKV({ lag = 0, failFlag = false } = {}) {
  const m = new Map();
  const wait = () => (lag ? new Promise(r => setTimeout(r, lag)) : null);
  const kv = { _m: m, puts: [],
    get: async k => { await wait(); return m.has(k) ? m.get(k).v : null; },
    put: async (k, v, o) => {
      await wait();
      if (failFlag && k.startsWith("srvflag_")) throw new Error("KV 429");
      kv.puts.push({ k, v, o }); m.set(k, { v, o });
    },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, metadata: (m.get(name).o || {}).metadata })), list_complete: true }),
  };
  return kv;
}
const errKeys = kv => [...kv._m.keys()].filter(k => k.startsWith("err_"));
const srcs = kv => errKeys(kv).map(k => JSON.parse(kv._m.get(k).v).items[0].src);

// mock fetch: payhip = { v1: fn | null, v2: fn | null } - fn(key, cred, url) vraci Response nebo vyhodi
let calls = [], payhip = {}, discord = [];
const realV1 = (k, cred, u) => {
  if (cred !== API) return new Response("", { status: 401 });
  const prod = u.searchParams.get("product_link");
  if (prod === "mquCD" && k === GOOD) return Response.json({ data: { enabled: true, license_key: k, uses: 0 } });
  if (prod === "mquCD" && k === DISABLED) return Response.json({ data: { enabled: false, license_key: k } });
  return Response.json({ data: [] });
};
const realV2 = (k, cred) => {
  if (cred !== SECRET) return new Response("", { status: 401 });
  const K = (k || "").toUpperCase();
  if (K === GOOD) return Response.json({ data: { enabled: true, product_link: "mquCD", license_key: GOOD, buyer_email: "x@y.z", uses: 0 } });
  if (K === DISABLED) return Response.json({ data: { enabled: false, product_link: "mquCD", license_key: DISABLED } });
  if (K === OTHER) return Response.json({ data: { enabled: true, product_link: "zzZZZ", license_key: OTHER } });
  return new Response("", { status: 400 });
};
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const h = new Headers(init.headers || {});
  if (u.host === "payhip.com" && u.pathname === "/api/v1/license/verify") {
    calls.push({ api: "v1", key: u.searchParams.get("license_key") });
    if (!payhip.v1) throw new Error("v1 nemelo byt volano");
    return payhip.v1(u.searchParams.get("license_key"), h.get("payhip-api-key"), u);
  }
  if (u.host === "payhip.com" && u.pathname === "/api/v2/license/verify") {
    calls.push({ api: "v2", key: u.searchParams.get("license_key") });
    if (!payhip.v2) throw new Error("v2 nemelo byt volano");
    return payhip.v2(u.searchParams.get("license_key"), h.get("product-secret-key"), u);
  }
  if (u.host === "api.github.com") {
    calls.push({ api: "gh", path: u.pathname });
    if (h.get("authorization") !== "Bearer ghtok") return new Response("", { status: 401 });
    return new Response(FILE + ":" + u.pathname, { status: 200 });
  }
  if (u.host === "discord.test") { discord.push(JSON.parse(init.body).content); return new Response("", { status: 204 }); }
  throw new Error("neocekavane URL " + u);
};

// env: v1/v2 = true -> spravny klic, string -> ten string, undefined -> chybi
function mkEnv({ v1, v2, kv, hook } = {}) {
  const e = { GH_TOKEN: "ghtok", GH_REPO: "o/r", FEEDBACK: kv };
  if (v1 !== undefined) e.PAYHIP_API_KEY = v1 === true ? API : v1;
  if (v2 !== undefined) e.PAYHIP_PRODUCT_SECRET = v2 === true ? SECRET : v2;
  if (hook) e.DISCORD_WEBHOOK = "https://discord.test/hook";
  return e;
}
async function call(q, env, { method = "GET", noWait = false } = {}) {
  calls = [];
  const waits = [];
  const ctx = { request: new Request("https://pitwise.net/api/update?" + q, { method }), env };
  if (!noWait) ctx.waitUntil = p => waits.push(p);
  const r = await update(ctx);
  await Promise.all(waits);
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch (e) {}
  return { status: r.status, d, text, ct: r.headers.get("content-type"), cd: r.headers.get("content-disposition"), waits: waits.length };
}
const q = (k, extra = "") => "file=ps1&key=" + encodeURIComponent(k) + extra;
const isFile = r => r.status === 200 && r.text.startsWith(FILE) && r.ct === "application/octet-stream";
const INVALID = r => r.status === 403 && r.d && r.d.ok === false && r.d.error === "invalid license key";
const DOWN = r => r.status === 503 && r.d && r.d.error === "license server unavailable, try again later";
const AUTH = r => r.status === 503 && r.d && r.d.ok === false && r.d.error === "license check temporarily unavailable on our side, try again later";
const seq = (...fs) => { let n = 0; return (...a) => fs[Math.min(n++, fs.length - 1)](...a); };

console.log("\n1) v2 (product secret) nastaveny");
{
  payhip = { v1: realV1, v2: realV2 };
  const kv = makeKV();
  const r = await call(q(GOOD), mkEnv({ v1: true, v2: true, kv }));
  ok(isFile(r) && r.text === FILE + ":/repos/o/r/contents/PitWise.ps1", "platny klic -> soubor (" + r.status + ")");
  ok(calls.filter(c => c.api === "v1").length === 0, "v1 se pri platnem v2 nevola");
  ok(r.cd === 'attachment; filename="PitWise.ps1"', "Content-Disposition beze zmeny");
  const b = await call("file=exe&channel=beta&key=" + GOOD, mkEnv({ v2: true, kv }));
  ok(isFile(b) && b.text.endsWith("/contents/beta/PitWise.exe"), "exe + channel=beta -> beta/PitWise.exe");
  const i = await call(q("NOPE-NOPE-NOPE-NOPE"), mkEnv({ v1: true, v2: true, kv }));
  ok(INVALID(i), "neznamy klic (v2 400, v1 data:[]) -> 403 invalid");
  ok(calls.map(c => c.api).join(",") === "v2,v1", "v2 400 se overi pres v1 (" + calls.map(c => c.api).join(",") + ")");
  ok(INVALID(await call(q("NOPE-NOPE-NOPE-NOPE"), mkEnv({ v2: true, kv }))) && calls.length === 1, "jen v2: 400 -> 403 bez v1");
  const d = await call(q(DISABLED), mkEnv({ v1: true, v2: true, kv }));
  ok(INVALID(d), "refundovany klic (enabled:false) -> 403");
  const o = await call(q(OTHER), mkEnv({ v1: true, v2: true, kv }));
  ok(INVALID(o), "platny klic k jinemu produktu (product_link) -> 403");
  payhip = { v2: () => new Response("", { status: 404 }) };
  ok(INVALID(await call(q(GOOD), mkEnv({ v2: true, kv }))), "v2 404 -> 403");
  payhip = { v2: () => Response.json({ data: { enabled: true, license_key: GOOD } }) };
  ok(isFile(await call(q(GOOD), mkEnv({ v2: true, kv }))), "v2 platny bez product_link v odpovedi -> soubor");
  payhip = { v1: realV1, v2: () => new Response("", { status: 502 }) };
  ok(isFile(await call(q(GOOD), mkEnv({ v1: true, v2: true, kv }))), "v2 502 + v1 platny -> soubor");
  ok(errKeys(kv).length === 0, "zadny zapis do errlogu");
}

console.log("\n1b) v2 secret k JINEMU produktu (400 na vsechno) -> v1 zachrani + 1 davka mismatch");
{
  const kv = makeKV();
  payhip = { v1: realV1, v2: () => new Response("", { status: 400 }) };
  ok(isFile(await call(q(GOOD), mkEnv({ v1: true, v2: true, kv }))), "v2 400 + v1 platny -> soubor (ne 403)");
  ok(srcs(kv).join() === "srv-update-mismatch", "1 davka srv-update-mismatch (" + srcs(kv).join() + ")");
  ok(isFile(await call(q(GOOD), mkEnv({ v1: true, v2: true, kv }))) && errKeys(kv).length === 1, "do hodiny zadna druha davka");
  ok(INVALID(await call(q("NOPE-NOPE-NOPE-NOPE"), mkEnv({ v1: true, v2: true, kv }))), "v2 400 + v1 data:[] -> 403");
  payhip = { v1: () => new Response("", { status: 503 }), v2: () => new Response("", { status: 400 }) };
  ok(INVALID(await call(q("NOPE-NOPE-NOPE-NOPE"), mkEnv({ v1: true, v2: true, kv: makeKV() }))), "v2 400 + v1 nejde -> drz se v2 (403)");
}

console.log("\n2) v2 odmitne nas secret (401) -> zaloha v1 + davka 'degraded'");
{
  payhip = { v1: realV1, v2: realV2 };
  const kv = makeKV();
  const r = await call(q(GOOD), mkEnv({ v1: true, v2: "prod_sk_STARY", kv }));
  ok(isFile(r), "v2 401 + v1 platny -> soubor");
  ok(calls[0].api === "v2" && calls[1].api === "v1", "poradi v2 -> v1");
  ok(srcs(kv).join() === "srv-update-degraded", "zachraneno zalohou -> 1 davka srv-update-degraded (" + srcs(kv).join() + ")");
  const dm = JSON.parse(kv._m.get(errKeys(kv)[0]).v).items[0].msg;
  ok(dm.startsWith("Payhip v2 401: ") && !dm.includes("prod_sk") && !dm.includes(GOOD), "msg bez klice/secretu: " + dm.slice(0, 50));
  const i = await call(q("NOPE-NOPE-NOPE-NOPE"), mkEnv({ v1: true, v2: "prod_sk_STARY", kv }));
  ok(INVALID(i), "v2 401 + v1 data:[] -> 403");
  payhip = { v1: realV1, v2: () => new Response("", { status: 403 }) };
  ok(isFile(await call(q(GOOD), mkEnv({ v1: true, v2: true, kv }))), "v2 403 -> zaloha v1 -> soubor");
  ok(errKeys(kv).length === 1, "degraded max 1x za hodinu");
}
{
  payhip = { v1: realV1, v2: realV2 };
  const kv = makeKV();
  const a = await call(q(GOOD), mkEnv({ v2: "prod_sk_STARY", kv }));
  ok(AUTH(a), "v2 401 + chybi API key -> 503 auth (NE 403) (" + a.status + ")");
  ok(a.waits === 1, "zapis pres context.waitUntil");
  const ek = errKeys(kv);
  ok(ek.length === 1, "prave 1 davka err_ (" + ek.length + ")");
  const e = kv._m.get(ek[0]);
  const bt = JSON.parse(e.v);
  ok(/^err_\d+_[a-z0-9]{1,6}$/.test(ek[0]) && bt.ts === parseInt(ek[0].split("_")[1], 10), "klic err_<ts>_<rnd6>");
  ok(bt.aid === "server-update" && bt.ver === "server" && bt.country === "--" && Array.isArray(bt.items) && bt.items.length === 1, "aid/ver/country/items");
  const it = bt.items[0];
  ok(it.src === "srv-update-auth" && /^\d{4}-\d\d-\d\dT/.test(it.at) && it.at.length <= 30, "src srv-update-auth, at ISO");
  ok(it.msg.startsWith("Payhip v2 401: our API credentials were rejected - customers cannot update"), "msg: " + it.msg);
  ok(e.o && e.o.expirationTtl === 60 * 60 * 24 * 30 && e.o.metadata.aid === "server-update" && e.o.metadata.ver === "server", "TTL 30 dni + metadata {aid, ver}");
  const fl = kv.puts.find(p => !p.k.startsWith("err_"));
  ok(fl && fl.k === "srvflag_update_auth" && fl.o && fl.o.expirationTtl === 3600, "throttle flag s TTL 3600 (" + (fl && fl.k) + ")");
  ok(kv.puts.findIndex(p => p.k === "srvflag_update_auth") < kv.puts.findIndex(p => p.k.startsWith("err_")), "flag se zapisuje PRED davkou");
  ok(!e.v.includes(GOOD) && !e.v.includes("prod_sk") && !e.v.includes(SECRET) && !e.v.includes(API), "v davce neni klic zakaznika ani secret");
}

console.log("\n3) oba nase klice odmitnute -> 503 auth, 1 davka, throttle 1x za hodinu");
{
  payhip = { v1: realV1, v2: realV2 };
  const kv = makeKV();
  const env = mkEnv({ v1: "acct_STARY", v2: "prod_sk_STARY", kv });
  const k1 = "abcd-efgh ijkl-mnop";                         // normalizace -> 2. pokus
  const r1 = await call(q(k1), env);
  ok(AUTH(r1), "v2 401 + v1 401 -> 503 auth");
  ok(calls.filter(c => c.api === "v2").length === 2 && calls.filter(c => c.api === "v1").length === 2, "oba pokusy (puvodni + normalizovany) pres v2 i v1");
  ok(errKeys(kv).length === 1, "1 davka");
  const msg = JSON.parse(kv._m.get(errKeys(kv)[0]).v).items[0].msg;
  ok(msg.startsWith("Payhip v2 401 / v1 401: "), "msg obsahuje obe API: " + msg.slice(0, 40));
  const all = [...kv._m.values()].map(x => x.v).join("|") + JSON.stringify(kv.puts.map(p => p.o));
  ok(![k1, "ABCDEFGHIJKLMNOP", "acct_STARY", "prod_sk_STARY", API, SECRET].some(s => all.includes(s)), "v KV neni klic zakaznika, API key ani secret");
  const r2 = await call(q(GOOD), env);
  ok(AUTH(r2), "druhe selhani -> 503 auth");
  ok(errKeys(kv).length === 1, "druhe selhani do hodiny -> zadna druha davka (" + errKeys(kv).length + ")");
  kv._m.delete("srvflag_update_auth");                      // flag vyprsel (TTL 3600)
  await call(q(GOOD), env);
  ok(errKeys(kv).length === 2, "po vyprseni flagu -> dalsi davka");
  // KV hazi / chybi / bez waitUntil -> odpoved porad 503 auth
  const bad = { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } };
  ok(AUTH(await call(q(GOOD), mkEnv({ v1: "x", kv: bad }))), "KV hazi -> porad 503 auth");
  ok(AUTH(await call(q(GOOD), mkEnv({ v1: "x" }))), "bez KV -> porad 503 auth");
  ok(AUTH(await call(q(GOOD), mkEnv({ v1: "x", kv: bad }), { noWait: true })), "bez context.waitUntil -> porad 503 auth");
  payhip = { v2: () => new Response("", { status: 422 }) };
  ok(AUTH(await call(q(GOOD), mkEnv({ v2: true, kv: makeKV() }))), "necekane 4xx z v2 (422) -> 503 auth, ne 403");
}

console.log("\n3b) throttle pod naporem + Discord");
{
  payhip = { v1: realV1 };
  const slow = makeKV({ lag: 20 });
  const rs = await Promise.all(Array.from({ length: 20 }, () => call(q(GOOD), mkEnv({ v1: "acct_STARY", kv: slow }))));
  ok(rs.every(AUTH), "20 soubeznych -> vsechny 503 auth");
  ok(errKeys(slow).length === 1, "20 soubeznych -> max 1 davka (" + errKeys(slow).length + ")");
  const ff = makeKV({ failFlag: true });
  for (let n = 0; n < 5; n++) await call(q(GOOD), mkEnv({ v1: "acct_STARY", kv: ff }));
  ok(errKeys(ff).length === 0, "zapis flagu selze -> zadna davka (ne 5) (" + errKeys(ff).length + ")");
  discord = [];
  const kv = makeKV();
  await call(q(GOOD), mkEnv({ v1: "acct_STARY", kv, hook: true }));
  await call(q(GOOD), mkEnv({ v1: "acct_STARY", kv, hook: true }));
  ok(discord.length === 1 && /srv-update-auth/.test(discord[0]) && /v1 401/.test(discord[0]), "Discord 1x (throttle): " + (discord[0] || "").slice(0, 60));
  ok(!discord.join().includes(GOOD) && !discord.join().includes("acct_STARY"), "Discord bez klice / API key");
  payhip = { v1: realV1 };
  discord = [];
  ok(isFile(await call(q(GOOD), mkEnv({ v1: true, kv: makeKV(), hook: true }))) && discord.length === 0, "platny klic -> zadna zprava do Discordu");
}

console.log("\n4) jen v1 (bez product secretu) - stav produkce do doplneni PAYHIP_PRODUCT_SECRET");
{
  const kv = makeKV();
  const env = mkEnv({ v1: true, kv });
  payhip = { v1: realV1 };
  ok(isFile(await call(q(GOOD), env)), "v1 platny -> soubor");
  ok(calls.every(c => c.api !== "v2"), "v2 se bez secretu nevola");
  ok(INVALID(await call(q("NOPE-NOPE-NOPE-NOPE"), env)), "v1 data:[] -> 403");
  ok(INVALID(await call(q(DISABLED), env)), "v1 enabled:false -> 403");
  payhip = { v1: () => Response.json({ data: { enabled: "yes" } }) };
  ok(INVALID(await call(q(GOOD), env)), "v1 enabled !== true -> 403");
  payhip = { v1: () => Response.json({ data: { enabled: true, product_link: "https://payhip.com/b/mquCD" } }) };
  ok(isFile(await call(q(GOOD), env)), "v1 platny s necekanym product_link -> soubor (kontrola jen u v2)");
  for (const [body, name] of [[{}, "{}"], [{ error: "Unauthenticated" }, "{error}"], [{ data: null }, "data:null"], [{ data: [{ enabled: true }] }, "data:[{..}]"]]) {
    payhip = { v1: () => Response.json(body) };
    ok(DOWN(await call(q(GOOD), env)), "v1 200 " + name + " -> 503 down (ne 403)");
  }
  payhip = { v1: realV1 };
  const a = await call(q(GOOD), mkEnv({ v1: "acct_STARY", kv }));
  ok(AUTH(a) && a.status !== 403, "v1 401 (pregenerovany API key = INCIDENT) -> 503, ne 403");
  ok(errKeys(kv).length === 1 && JSON.parse(kv._m.get(errKeys(kv)[0]).v).items[0].msg.startsWith("Payhip v1 401: "), "davka 'Payhip v1 401'");
  for (const [s, name] of [[429, "429"], [500, "500"], [502, "502"]]) {
    payhip = { v1: () => new Response("", { status: s }) };
    ok(DOWN(await call(q(GOOD), env)), "v1 " + name + " -> 503 down");
  }
  payhip = { v1: () => { throw new TypeError("network"); } };
  ok(DOWN(await call(q(GOOD), env)), "sitova chyba -> 503 down");
  payhip = { v1: () => new Response("<html>oops", { status: 200 }) };
  ok(DOWN(await call(q(GOOD), env)), "200 s neprectitelnym telem -> 503 down");
  // maly pismena: 1. pokus data:[], normalizovany 2. pokus Payhip nejde -> NE 403
  payhip = { v1: seq(() => Response.json({ data: [] }), () => new Response("", { status: 429 })) };
  ok(DOWN(await call(q("abcd-efgh-ijkl-mnop"), env)), "maly pismena, 2. pokus 429 -> 503 (ne 403)");
  payhip = { v1: seq(() => Response.json({ data: [] }), () => { throw new TypeError("network"); }) };
  ok(DOWN(await call(q("ABCD- EFGH-IJKL-MNOP"), env)), "mezera v klici, 2. pokus sitova chyba -> 503 (ne 403)");
  ok(errKeys(kv).length === 1, "down se do errlogu nepise");
  ok(INVALID(await call(q("A".repeat(300)), env)) && calls.length === 0, "obri klic (300 znaku) -> 403 bez dotazu na Payhip");
}

console.log("\n5) normalizovany 2. pokus + prednost vysledku");
{
  const kv = makeKV();
  payhip = { v1: realV1 };
  const raw = "abcd-efgh" + ZW + "-ijkl-mnop";
  const r = await call(q(" " + raw + " "), mkEnv({ v1: true, kv }));
  ok(isFile(r), "maly pismena + zero-width mezera -> 2. pokus normalizovany -> soubor");
  ok(calls.filter(c => c.api === "v1").map(c => c.key).join(",") === raw + "," + GOOD, "1. pokus orezany puvodni, 2. normalizovany");
  payhip = { v2: realV2 };
  ok(isFile(await call(q("abcd-efgh-ijkl-mnop"), mkEnv({ v2: true, kv }))), "v2 je case-insensitive -> 1 pokus staci");
  ok(calls.length === 2 && calls[0].api === "v2", "jen 1 dotaz na Payhip + GitHub");
  ok(INVALID(await call(q(GOOD), mkEnv({ v1: true, kv }))) === false, "(kontrola) platny klic neni 403");
  // poradi vysledku pres oba pokusy: valid vyhrava; jinak je smerodatny normalizovany klic, kdyz rekl invalid
  // nebo kdyz surovy byl jen invalid; jinak zustava vysledek 1. pokusu (down / auth = 503)
  const R = { valid: () => Response.json({ data: { enabled: true } }), invalid: () => Response.json({ data: [] }),
    down: () => new Response("", { status: 503 }), auth: () => new Response("", { status: 401 }) };
  const expect = { valid: isFile, invalid: INVALID, down: DOWN, auth: AUTH };
  const order = ["valid", "invalid", "down", "auth"];
  for (const a of order) for (const b of order) {
    const want = a === "valid" || b === "valid" ? "valid" : b === "invalid" ? "invalid" : a === "invalid" ? b : a;
    payhip = { v1: seq(R[a], R[b]) };
    const res = await call(q("abcd-efgh-ijkl-mnop"), mkEnv({ v1: true, kv: makeKV() }));
    const tries = calls.filter(c => c.api === "v1").length;
    ok(expect[want](res) && tries === (a === "valid" ? 1 : 2), "1. " + a + " + 2. " + b + " -> " + want + " (" + res.status + ", pokusu " + tries + ")");
  }
}

console.log("\n6) beze zmeny: chybejici klic, spatny file, metoda, konfigurace, GitHub chyba");
{
  payhip = { v1: realV1, v2: realV2 };
  const m = await call(q(""), mkEnv({ v1: true, v2: true }));
  ok(m.status === 403 && m.d.error === "license key required" && calls.length === 0, "chybi klic -> 403 license key required");
  const ws = await call(q("   "), mkEnv({ v1: true }));
  ok(ws.status === 403 && ws.d.error === "license key required", "klic z mezer -> 403 license key required");
  const bf = await call("file=dll&key=" + GOOD, mkEnv({ v1: true }));
  ok(bf.status === 400 && bf.d.error === "bad file param (ps1|exe)" && calls.length === 0, "file=dll -> 400");
  const pm = await call(q(GOOD), mkEnv({ v1: true }), { method: "POST" });
  ok(pm.status === 405 && pm.d.error === "method", "POST -> 405");
  const nc = await call(q(GOOD), mkEnv({}));
  ok(nc.status === 500 && nc.d.error === "endpoint not configured" && calls.length === 0, "zadny Payhip klic -> 500 endpoint not configured");
  const ng = await call(q(GOOD), { PAYHIP_API_KEY: API, GH_REPO: "o/r" });
  ok(ng.status === 500 && ng.d.error === "endpoint not configured", "chybi GH_TOKEN -> 500");
  ok(isFile(await call(q(GOOD), mkEnv({ v2: true }))), "jen PAYHIP_PRODUCT_SECRET -> funguje");
  ok(isFile(await call(q(GOOD), mkEnv({ v1: true }))), "jen PAYHIP_API_KEY -> funguje");
  const gf = await call(q(GOOD), { ...mkEnv({ v1: true }), GH_TOKEN: "bad" });
  ok(gf.status === 502 && gf.d.error === "file fetch failed 401", "GitHub 401 -> 502 file fetch failed 401");
  const ct = await call(q("NOPE"), mkEnv({ v1: true }));
  ok(ct.ct === "application/json", "chybove odpovedi porad application/json");
}

console.log("\n7) davka je citelna pro errlog GET a watchdog ji zaradi jako licence-server");
{
  payhip = { v1: realV1 };
  const kv = makeKV();
  await call(q(GOOD), mkEnv({ v1: "acct_STARY", kv }));
  const g = await (await errlog({ request: new Request("https://pitwise.net/api/errlog?token=T&aid=server-update"), env: { FEEDBACK: kv, ADMIN_TOKEN: "T" } })).json();
  ok(g.ok && g.count === 1 && g.items[0].items[0].src === "srv-update-auth", "errlog GET &aid=server-update -> 1 davka srv-update-auth");
  const w = await (await watchdog({ request: new Request("https://pitwise.net/api/watchdog?token=T&dry=1"), env: { FEEDBACK: kv, ADMIN_TOKEN: "T" } })).json();
  ok(w.byCategory && w.byCategory["licence-server"] === 1 && !w.byCategory["ai-klic"], "watchdog: licence-server 1x, ne ai-klic (" + JSON.stringify(w.byCategory) + ")");
}

console.log("\n8) zdroj update.js je ciste ASCII (zadne neviditelne znaky v regexu)");
{
  const srcText = readFileSync(new URL("./_build/update.mjs", import.meta.url), "utf8");
  const zw = [0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF].map(c => String.fromCharCode(c));
  ok(!zw.some(c => srcText.includes(c)), "zadny U+200B-200D / U+2060 / U+FEFF v souboru");
  ok(srcText.split("\n").filter(l => /\.replace\(/.test(l)).every(l => /^[\x00-\x7F]*$/.test(l)), "radek s normalizaci je ASCII");
}

console.log("\n9) hodnoty z dashboardu: uvozovky / mezery / zalomeni / neviditelne znaky se orezou");
{
  payhip = { v1: realV1, v2: realV2 };
  const kv = makeKV();
  ok(isFile(await call(q(GOOD), mkEnv({ v1: '"' + API + '"', kv }))), "API key v uvozovkach -> soubor");
  const s = await call(q(GOOD), mkEnv({ v1: true, v2: " " + SECRET + "\r\n", kv }));
  ok(isFile(s) && calls.filter(c => c.api === "v1").length === 0, "secret s mezerou a CRLF -> v2 platny, v1 se nevola");
  ok(isFile(await call(q(GOOD), mkEnv({ v2: "'" + SECRET + "'", kv }))), "secret v apostrofech -> soubor");
  ok(isFile(await call(q(GOOD), mkEnv({ v1: API.slice(0, 5) + ZW + API.slice(5), kv }))), "zero-width znak uprostred API key -> soubor");
  ok(isFile(await call(q(GOOD), mkEnv({ v1: API.slice(0, 6) + "\n" + API.slice(6), kv }))), "zalomeni uprostred API key -> soubor (ne 503 down)");
  const LRM = String.fromCharCode(0x200E), NBSP = String.fromCharCode(0xA0), LQ = String.fromCharCode(0x201C), RQ = String.fromCharCode(0x201D);
  ok(isFile(await call(q(GOOD), mkEnv({ v1: LRM + API + NBSP, kv }))), "LRM + nezlomitelna mezera kolem API key -> soubor");
  ok(isFile(await call(q(GOOD), mkEnv({ v2: LQ + SECRET + RQ, kv }))), "typograficke uvozovky kolem secretu -> soubor");
  ok(errKeys(kv).length === 0, "orezane hodnoty -> zadna davka do errlogu");
  const ekv = makeKV();
  const e = await call(q(GOOD), mkEnv({ v1: '""', kv: ekv }));
  ok(AUTH(e) && calls.length === 0, "API key jen z uvozovek -> 503 auth bez dotazu na Payhip (ne tichy 500)");
  ok(srcs(ekv).join() === "srv-update-auth" && /empty after removing quotes/.test(JSON.parse(ekv._m.get(errKeys(ekv)[0]).v).items[0].msg), "-> davka srv-update-auth 'empty after removing quotes'");
  ok(AUTH(await call(q(GOOD), mkEnv({ v1: "  ", v2: "''", kv: makeKV() }))), "oba jen mezery/uvozovky -> 503 auth");
}

console.log("\n10) prohozene PAYHIP_API_KEY <-> PAYHIP_PRODUCT_SECRET -> aktualizace jdou + 1 davka srv-update-swapped");
{
  payhip = { v1: realV1, v2: realV2 };
  const kv = makeKV();
  const env = mkEnv({ v1: SECRET, v2: API, kv });                // prohozene v Cloudflare
  const r = await call(q(GOOD), env);
  ok(isFile(r), "prohozene klice + platny klic -> soubor (" + r.status + ")");
  ok(calls.filter(c => c.api !== "gh").map(c => c.api).join() === "v2,v1,v2", "poradi v2,v1 (puvodni) -> v2 prohozene (" + calls.map(c => c.api).join() + ")");
  ok(srcs(kv).join() === "srv-update-swapped", "1 davka srv-update-swapped, zadna auth/degraded (" + srcs(kv).join() + ")");
  const all = [...kv._m.values()].map(x => x.v).join("|");
  ok(![GOOD, API, SECRET].some(x => all.includes(x)), "v davce neni klic zakaznika, API key ani secret");
  ok(isFile(await call(q(GOOD), env)) && errKeys(kv).length === 1, "druhy pozadavek do hodiny -> zadna druha davka");
  ok(INVALID(await call(q("NOPE-NOPE-NOPE-NOPE"), env)), "prohozene klice + neznamy klic -> 403 invalid (ne 503)");
  ok(isFile(await call(q("abcd-efgh-ijkl-mnop"), env)), "prohozene klice + maly pismena -> normalizovany pokus -> soubor");
  // prohozene poradi Payhip nepotvrdi (je dole) -> zustava 503 auth, ne "swapped"
  const kv2 = makeKV();
  payhip = { v1: (k, c) => new Response("", { status: c === API ? 503 : 401 }), v2: (k, c) => new Response("", { status: c === SECRET ? 503 : 401 }) };
  ok(AUTH(await call(q(GOOD), mkEnv({ v1: SECRET, v2: API, kv: kv2 }))), "prohozene, ale Payhip dole -> 503 auth");
  ok(srcs(kv2).join() === "srv-update-auth", "-> davka srv-update-auth, ne swapped (" + srcs(kv2).join() + ")");
  // ciste spatne hodnoty spravneho tvaru -> prohozeni se nezkousi (zadne zbytecne dotazy)
  payhip = { v1: realV1, v2: realV2 };
  ok(AUTH(await call(q(GOOD), mkEnv({ v1: "acct_STARY", v2: "prod_sk_STARY", kv: makeKV() }))) && calls.length === 2, "spatne hodnoty spravneho tvaru -> jen 2 dotazy (" + calls.length + ")");
  // API key v obou polich -> v2 s API key = 401, zaloha v1 zachrani (prohozeni stejnych hodnot nema smysl)
  ok(isFile(await call(q(GOOD), mkEnv({ v1: API, v2: API, kv: makeKV() }))) && calls.filter(c => c.api !== "gh").length === 2, "stejna hodnota v obou -> v2 401, zaloha v1 -> soubor, 2 dotazy");
  // secret v obou polich -> v2 hned platny
  ok(isFile(await call(q(GOOD), mkEnv({ v1: SECRET, v2: SECRET, kv: makeKV() }))), "secret v obou -> v2 platny -> soubor");
  // API key vlozeny do PAYHIP_PRODUCT_SECRET (bez prod_sk_) + stary API key -> prohozene poradi: v2 401, v1 platny
  const kv3 = makeKV();
  ok(isFile(await call(q(GOOD), mkEnv({ v1: "acct_STARY", v2: API, kv: kv3 }))), "API key v poli secretu + stary API key -> soubor");
  ok(calls.filter(c => c.api !== "gh").map(c => c.api).join() === "v2,v1,v2,v1", "poradi v2,v1 -> v2,v1 prohozene (" + calls.map(c => c.api).join() + ")");
  ok(srcs(kv3).join() === "srv-update-swapped", "-> 1 davka srv-update-swapped (" + srcs(kv3).join() + ")");
  // REVIEW 24.10.: secret JINEHO produktu v PAYHIP_API_KEY + stara hodnota v PAYHIP_PRODUCT_SECRET.
  // Prohozene: v2 s cizim secretem = 400 na vsechno ("invalid"), v1 se starou hodnotou = 401 -> NESMI to byt 403 vsem.
  const OTHER_SK = "prod_sk_OTHERPRODUCT";
  for (const stale of ["prod_sk_STARY", "acct_STARY"]) {
    payhip = { v1: realV1, v2: (k, c, u) => c === OTHER_SK ? new Response("", { status: 400 }) : realV2(k, c, u) };
    const kv4 = makeKV();
    const env4 = mkEnv({ v1: OTHER_SK, v2: stale, kv: kv4 });
    ok(AUTH(await call(q(GOOD), env4)), "cizi secret v API key + " + stale + " -> platici zakaznik 503 auth (NE 403)");
    ok(AUTH(await call(q("abcd-efgh-ijkl-mnop"), env4)), "  ... i s malymi pismeny -> 503 auth");
    ok(srcs(kv4).join() === "srv-update-auth", "  ... davka srv-update-auth, ne swapped (" + srcs(kv4).join() + ")");
  }
  // polovicni prohozeni: v PAYHIP_API_KEY je NAS secret, v PAYHIP_PRODUCT_SECRET stara hodnota -> platici dostane soubor
  payhip = { v1: realV1, v2: realV2 };
  const kv5 = makeKV();
  const env5 = mkEnv({ v1: SECRET, v2: "acct_STARY", kv: kv5 });
  ok(isFile(await call(q(GOOD), env5)) && srcs(kv5).join() === "srv-update-swapped", "nas secret v API key + stara hodnota -> soubor + swapped");
  ok(AUTH(await call(q("NOPE-NOPE-NOPE-NOPE"), env5)), "  ... neznamy klic -> 503 (v prohozenem poradi 1 hodnota odmitnuta), ne 403");
}

console.log("\n11) diagnostika ?diag=1&token= (jen tvar hodnot + zivy test, nikdy hodnoty)");
{
  const { createHash } = await import("node:crypto");
  const sha8 = s => createHash("sha256").update("pitwise-diag:" + s).digest("hex").slice(0, 8);
  const rawSha8 = s => createHash("sha256").update(s).digest("hex").slice(0, 8);
  const dq = (t) => "diag=1" + (t === undefined ? "" : "&token=" + t);
  const denv = (o) => ({ ...mkEnv(o), ADMIN_TOKEN: "T0ken" });
  payhip = { v1: realV1, v2: realV2 };
  for (const [qq, env, name] of [[dq(), denv({ v1: true }), "bez tokenu"], [dq("spatny"), denv({ v1: true }), "spatny token"],
    [dq("T0ke"), denv({ v1: true }), "kratsi token"], [dq("T0ken"), mkEnv({ v1: true }), "ADMIN_TOKEN nenastaveny"]]) {
    const r = await call(qq, env);
    ok(r.status === 401 && r.d.error === "unauthorized" && calls.length === 0, "diag " + name + " -> 401 bez dotazu na Payhip");
  }
  ok((await call(dq("T0ken"), denv({ v1: true }), { method: "POST" })).status === 405, "diag POST -> 405");
  const g = await call(dq("T0ken"), denv({ v1: '"' + API + '"', v2: true }));
  ok(g.status === 200 && g.d.ok && g.d.verdict === "ok", "spravne klice -> verdict ok (" + (g.d && g.d.verdict) + ")");
  ok(g.d.probe.v1_with_PAYHIP_API_KEY.http === 200 && g.d.probe.v1_with_PAYHIP_API_KEY.means === "accepted", "v1 s API key: 200 accepted");
  ok(g.d.probe.v2_with_PAYHIP_PRODUCT_SECRET.http === 400 && g.d.probe.v2_with_PAYHIP_PRODUCT_SECRET.means === "accepted", "v2 se secretem: 400 accepted");
  ok(g.d.probe.v1_with_PAYHIP_PRODUCT_SECRET.means === "rejected" && g.d.probe.v2_with_PAYHIP_API_KEY.means === "rejected", "obracene poradi: rejected");
  const ca = g.d.creds.PAYHIP_API_KEY, cs = g.d.creds.PAYHIP_PRODUCT_SECRET;
  ok(ca.set && ca.quoted && ca.cleanedUp && ca.len === API.length + 2 && ca.cleanLen === API.length && !ca.looksLikeProductSecret, "tvar API key: uvozovky, orezano, delky");
  ok(ca.fp8 === sha8(API) && cs.fp8 === sha8(SECRET) && cs.looksLikeProductSecret && !cs.cleanedUp, "fp8 = sha256('pitwise-diag:'+orezana hodnota), secret prod_sk_");
  ok(ca.fp8 !== rawSha8(API) && !g.text.includes(rawSha8(API)), "fp8 NENI zacatek sha256(API key) = podpisu Payhip webhooku");
  ok(/NOT verified/.test(g.d.hint) && /re-paste it cleanly/.test(g.d.hint), "hint: vazba na produkt neoverena + upozorneni na orezanou hodnotu");
  ok(![API, SECRET, "acct_api_key", "SECRET456", "SECRET123"].some(x => g.text.includes(x)), "v odpovedi diag neni API key ani secret (ani jejich casti)");
  ok(calls.every(c => c.key === "PWDIAG-0000-0000-0000"), "diag testuje jen vymysleny licencni klic");
  ok((await call(dq("T0ken"), denv({ v1: SECRET, v2: API }))).d.verdict === "swapped", "prohozene -> verdict swapped");
  const w = await call(dq("T0ken"), denv({ v1: "acct_STARY", v2: "prod_sk_STARY" }));
  ok(w.d.verdict === "both-rejected" && /CURRENT API key/.test(w.d.hint), "oba spatne -> both-rejected + navod");
  const o = await call(dq("T0ken"), denv({ v1: true }));
  ok(o.d.verdict === "ok-api-key-only" && o.d.probe.v2_with_PAYHIP_PRODUCT_SECRET.means === "not set" && !o.d.creds.PAYHIP_PRODUCT_SECRET.set, "jen API key -> ok-api-key-only, secret not set");
  ok((await call(dq("T0ken"), denv({ v1: "acct_STARY", v2: true }))).d.verdict === "ok-product-secret-only", "jen secret funguje -> ok-product-secret-only");
  payhip = { v1: () => new Response("", { status: 503 }), v2: () => new Response("", { status: 502 }) };
  ok((await call(dq("T0ken"), denv({ v1: true, v2: true }))).d.verdict === "payhip-unclear", "Payhip dole -> payhip-unclear");
  // REVIEW 24.10.: jen JEDNA promenna se secretem v poli API key -> update da 503, diag nesmi rict "swapped, jde to"
  payhip = { v1: realV1, v2: realV2 };
  const wv = await call(dq("T0ken"), denv({ v1: SECRET }));
  ok(wv.d.verdict === "wrong-variable" && /do NOT work/.test(wv.d.hint), "jen secret v PAYHIP_API_KEY -> wrong-variable (" + wv.d.verdict + ")");
  ok(AUTH(await call(q(GOOD), mkEnv({ v1: SECRET }))), "  ... a update opravdu 503 (shoda s diag)");
  ok((await call(dq("T0ken"), denv({ v2: API }))).d.verdict === "wrong-variable", "jen API key v PAYHIP_PRODUCT_SECRET -> wrong-variable");
  ok((await call(dq("T0ken"), denv({ v1: SECRET, v2: "prod_sk_STARY" }))).d.verdict === "swapped", "nas secret v API key + stary secret -> swapped");
  ok(isFile(await call(q(GOOD), mkEnv({ v1: SECRET, v2: "prod_sk_STARY", kv: makeKV() }))), "  ... a update opravdu jde (shoda s diag)");
  // 429 na prohozenych sondach -> payhip-unclear, ne both-rejected
  payhip = { v1: (k, c, u) => c === API ? realV1(k, c, u) : new Response("", { status: c === "acct_STARY" ? 401 : 429 }),
    v2: (k, c) => new Response("", { status: c === "prod_sk_STARY" ? 401 : 429 }) };
  ok((await call(dq("T0ken"), denv({ v1: "acct_STARY", v2: "prod_sk_STARY" }))).d.verdict === "payhip-unclear", "429 na prohozenych sondach -> payhip-unclear");
  // v2 200 s neprectitelnym telem -> unclear (shoda s classify)
  payhip = { v1: () => new Response("", { status: 401 }), v2: () => new Response("<html>", { status: 200 }) };
  const ht = await call(dq("T0ken"), denv({ v1: "acct_STARY", v2: "prod_sk_X" }));
  ok(ht.d.probe.v2_with_PAYHIP_PRODUCT_SECRET.means === "unclear", "v2 200 bez JSON -> unclear");
  // tvar: typograficke uvozovky a neviditelne znaky
  payhip = { v1: realV1, v2: realV2 };
  const sq = await call(dq("T0ken"), denv({ v1: String.fromCharCode(0x201C) + API + String.fromCharCode(0x201D) }));
  ok(sq.d.creds.PAYHIP_API_KEY.quoted && sq.d.creds.PAYHIP_API_KEY.nonAscii && sq.d.creds.PAYHIP_API_KEY.cleanLen === API.length && sq.d.verdict === "ok-api-key-only", "typograficke uvozovky -> quoted, nonAscii, orezano, funguje");
  payhip = { v1: realV1, v2: realV2 };
  ok(isFile(await call(q(GOOD) + "&diag=0", mkEnv({ v1: true }))), "diag=0 -> normalni update");
}

console.log("\n" + pass + " OK, " + fail + " FAIL");
process.exit(fail ? 1 : 0);
