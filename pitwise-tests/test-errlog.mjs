// Testy /api/errlog: GET strankovani (nejnovejsi prvni, cursor, aid, since, limit) + POST beze zmeny chovani.
// Mock KV napodobuje Cloudflare: list abecedne, max 1000 klicu na stranku + cursor/list_complete, metadata ve vypisu.
// Kazde volani funkce pocita KV operace - Cloudflare jich na jedno volani povoli ~1000.
import { onRequest as errlog } from "./_build/errlog.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK   " + m); } else { fail++; console.log("  FAIL " + m); } };

function makeKV() {
  const m = new Map(); // name -> { v, meta }
  const kv = { _m: m, ops: 0,
    get: async k => { kv.ops++; return m.has(k) ? m.get(k).v : null; },
    put: async (k, v, o) => { kv.ops++; m.set(k, { v, meta: o && o.metadata !== undefined ? o.metadata : null }); },
    delete: async k => { kv.ops++; m.delete(k); },
    list: async ({ prefix, cursor, limit }) => {
      kv.ops++;
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const from = cursor ? parseInt(cursor, 10) : 0, n = Math.min(limit || 1000, 1000);
      const keys = all.slice(from, from + n).map(name => (m.get(name).meta ? { name, metadata: m.get(name).meta } : { name }));
      const done = from + n >= all.length;
      return done ? { keys, list_complete: true } : { keys, list_complete: false, cursor: String(from + n) };
    } };
  return kv;
}
const env = kv => ({ FEEDBACK: kv, ADMIN_TOKEN: "T" });
async function get(kv, q = "") {
  kv.ops = 0;
  const r = await errlog({ request: new Request("https://pitwise.net/api/errlog?token=T" + q), env: env(kv) });
  return { status: r.status, d: await r.json(), ops: kv.ops };
}
async function post(kv, body, ip = "1.2.3.4") {
  const r = await errlog({ request: new Request("https://pitwise.net/api/errlog", { method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, "cf-ipcountry": "CZ" }, body: JSON.stringify(body) }), env: env(kv) });
  return { status: r.status, d: await r.json() };
}
// davka primo do KV; meta=false = stara davka (pred nasazenim, bez metadat)
let seq = 0;
function seed(kv, ts, aid, meta) {
  const name = "err_" + ts + "_" + (seq++).toString(36).padStart(6, "x");
  kv._m.set(name, { v: JSON.stringify({ ver: "2.29.6", aid, ts, country: "CZ", bid: "", items: [{ at: "x", src: "mic", msg: "m" + ts }] }), meta: meta ? { aid, ver: "2.29.6" } : null });
  return name;
}
const desc = arr => arr.every((x, i) => i === 0 || arr[i - 1].ts >= x.ts);
async function all(kv, q) {
  const out = []; let c = "", pages = 0, maxOps = 0;
  for (;;) {
    const r = await get(kv, q + (c ? "&cursor=" + c : ""));
    pages++; maxOps = Math.max(maxOps, r.ops);
    out.push(...r.d.items);
    if (r.d.list_complete) { if (r.d.cursor !== null) out.bad = true; break; }
    c = r.d.cursor;
    if (pages > 50) { out.bad = true; break; }
  }
  return { items: out, pages, maxOps };
}

const T0 = 1760000000000;
const SIMON = "283451f1656c08a3d139";

console.log("\n1) POST: davka se ulozi s metadaty, dedup podle bid funguje dal");
{
  const kv = makeKV();
  const r1 = await post(kv, { ver: "2.29.6", aid: SIMON, bid: "abc123", items: [{ at: "1", src: "mic", msg: "err=empty" }] });
  ok(r1.status === 200 && r1.d.ok === true && !r1.d.dup, "prvni POST ok");
  const errKeys = [...kv._m.keys()].filter(k => k.startsWith("err_"));
  ok(errKeys.length === 1, "1 klic err_");
  const e = kv._m.get(errKeys[0]);
  ok(e.meta && e.meta.aid === SIMON && e.meta.ver === "2.29.6", "metadata { aid, ver } (" + JSON.stringify(e.meta) + ")");
  const b = JSON.parse(e.v);
  ok(b.aid === SIMON && b.country === "CZ" && b.bid === "abc123" && b.items[0].msg === "err=empty", "obsah davky beze zmeny");
  const r2 = await post(kv, { ver: "2.29.6", aid: SIMON, bid: "abc123", items: [{ at: "1", src: "mic", msg: "err=empty" }] });
  ok(r2.d.ok === true && r2.d.dup === true, "stejny bid -> dup");
  ok([...kv._m.keys()].filter(k => k.startsWith("err_")).length === 1, "porad 1 klic err_");
  const r3 = await post(kv, { ver: "2.29.6", aid: SIMON, items: [] });
  ok(r3.status === 400, "prazdna davka -> 400");
  const g = await get(kv);
  ok(g.d.count === 1 && g.d.items[0].aid === SIMON && g.d.items[0]._key === errKeys[0], "GET ji vrati i s _key");
}

console.log("\n2) GET: token, prazdne KV, spatny cursor, metoda");
{
  const kv = makeKV();
  const r = await errlog({ request: new Request("https://pitwise.net/api/errlog?token=X"), env: env(kv) });
  ok(r.status === 401, "spatny token -> 401");
  const e = await get(kv);
  ok(e.status === 200 && e.d.ok && e.d.count === 0 && e.d.items.length === 0 && e.d.list_complete === true && e.d.cursor === null && e.d.total === 0, "prazdne KV: ok, nic, list_complete");
  const bc = await get(kv, "&cursor=../etc");
  ok(bc.status === 400 && bc.d.error === "bad cursor", "nesmyslny cursor -> 400");
  const m = await errlog({ request: new Request("https://pitwise.net/api/errlog?token=T", { method: "PUT" }), env: env(kv) });
  ok(m.status === 405, "PUT -> 405");
}

console.log("\n3) 2500 davek (= nad 1000, puvodni chyba): vychozi stranka = 500 NEJNOVEJSICH");
const big = makeKV();
const N = 2500;
for (let i = 0; i < N; i++) seed(big, T0 + i * 60000, i % 50 === 7 ? SIMON : "a" + (i % 40), i >= 1600); // prvnich 1600 bez metadat
{
  const r = await get(big);
  ok(r.status === 200 && r.d.ok, "ok");
  ok(r.d.count === 500 && r.d.items.length === 500, "count 500 (" + r.d.count + ")");
  ok(r.d.items[0].ts === T0 + (N - 1) * 60000, "prvni = uplne nejnovejsi davka");
  ok(desc(r.d.items), "serazeno nejnovejsi prvni");
  ok(r.d.list_complete === false && typeof r.d.cursor === "string", "list_complete=false + cursor");
  ok(r.d.total === N, "total = " + r.d.total);
  ok(r.ops <= 1000, "KV operaci " + r.ops + " <= 1000");
  ok(r.d.items.every(b => Array.isArray(b.items) && typeof b._key === "string"), "tvar davek pro admin beze zmeny (items[], _key)");
}

console.log("\n4) Strankovani limit=900 projde vsech 2500 bez der a duplicit");
{
  const a = await all(big, "&limit=900");
  const keys = new Set(a.items.map(b => b._key));
  ok(a.items.length === N && keys.size === N, "2500 davek, 2500 unikatnich (" + a.items.length + "/" + keys.size + ")");
  ok(desc(a.items), "pres stranky porad nejnovejsi prvni");
  ok(a.pages === 3, "3 stranky (" + a.pages + ")");
  ok(a.maxOps <= 1000, "max KV operaci na volani " + a.maxOps);
  ok(!a.items.bad, "posledni stranka: cursor null");
}

console.log("\n5) limit: max 900, nesmysl -> 500, zaporny -> 1");
{
  ok((await get(big, "&limit=5000")).d.count === 900, "limit=5000 -> 900");
  ok((await get(big, "&limit=abc")).d.count === 500, "limit=abc -> 500");
  ok((await get(big, "&limit=-3")).d.count === 1, "limit=-3 -> 1");
  ok((await get(big, "&limit=10")).d.count === 10, "limit=10 -> 10");
}

console.log("\n6) aid= : jen davky jednoho cloveka, i pres stare davky bez metadat");
{
  const expect = [...big._m.values()].map(e => JSON.parse(e.v)).filter(b => b.aid === SIMON).length;
  const a = await all(big, "&aid=" + SIMON);
  ok(expect === 50 && a.items.length === expect, "vsech " + expect + " davek Simona (" + a.items.length + ")");
  ok(a.items.every(b => b.aid === SIMON), "zadna cizi davka");
  ok(desc(a.items), "nejnovejsi prvni");
  ok(a.maxOps <= 1000, "max KV operaci na volani " + a.maxOps + " (" + a.pages + " stranky)");
  const r = await get(big, "&aid=" + SIMON + "&limit=18");
  // novejsich 900 klicu ma metadata -> cizi se nectou: 18 Simonovych = 3 list + 18 get
  ok(r.d.count === 18 && r.ops === 3 + 18, "s metadaty se ctou jen Simonovy davky (ops " + r.ops + ")");
  const p = await all(big, "&aid=283451");
  ok(p.items.length === expect, "aid=zacatek id (283451) najde totez");
  const none = await get(big, "&aid=neexistuje");
  ok(none.d.count === 0, "neznamy aid -> 0");
}

console.log("\n7) aid= nad samymi starymi davkami (bez metadat): rozpocet operaci + pokracovani");
{
  const kv = makeKV();
  for (let i = 0; i < 2000; i++) seed(kv, T0 + i * 1000, i % 100 === 3 ? SIMON : "b" + i, false);
  const r1 = await get(kv, "&aid=" + SIMON);
  ok(r1.ops <= 1000, "1. volani KV operaci " + r1.ops + " <= 1000");
  ok(r1.d.list_complete === false && r1.d.cursor, "nestihne vse -> cursor");
  const a = await all(kv, "&aid=" + SIMON);
  ok(a.items.length === 20 && a.items.every(b => b.aid === SIMON), "nakonec vsech 20 (" + a.items.length + ")");
  ok(a.maxOps <= 1000, "max KV operaci " + a.maxOps);
}

console.log("\n8) since= (ms, vcetne): jen novejsi davky, bez cteni starsich");
{
  const s = T0 + (N - 100) * 60000;
  const r = await get(big, "&since=" + s);
  ok(r.d.count === 100 && r.d.list_complete === true && r.d.cursor === null, "100 davek, hotovo (" + r.d.count + ")");
  ok(r.d.items.every(b => b.ts >= s), "vsechny ts >= since");
  ok(r.ops === 3 + 100, "precte jen 100 davek (ops " + r.ops + ")");
  const r2 = await get(big, "&since=" + s + "&limit=30");
  ok(r2.d.count === 30 && r2.d.list_complete === false, "since + limit -> stranka 30 a dalsi");
  const a = await all(big, "&since=" + s + "&limit=30");
  ok(a.items.length === 100 && new Set(a.items.map(b => b._key)).size === 100, "strankovane since = 100 unikatnich");
  const sa = await all(big, "&since=" + (T0 + 2000 * 60000) + "&aid=" + SIMON);
  ok(sa.items.length === 10 && sa.items.every(b => b.aid === SIMON && b.ts >= T0 + 2000 * 60000), "since + aid (" + sa.items.length + ")");
  ok((await get(big, "&since=" + (T0 + N * 60000))).d.count === 0, "since v budoucnu -> 0");
}

console.log("\n9) cursor odkazuje na klic, ktery mezitim vyprsel (TTL): pokracuje se dal");
{
  const kv = makeKV();
  const names = [];
  for (let i = 0; i < 30; i++) names.push(seed(kv, T0 + i * 1000, "c", true));
  const r1 = await get(kv, "&limit=10");
  kv._m.delete(r1.d.cursor);                       // posledni klic prvni stranky vyprsel
  const r2 = await get(kv, "&limit=10&cursor=" + r1.d.cursor);
  ok(r2.d.count === 10 && r2.d.items[0].ts === T0 + 19 * 1000, "druha stranka zacina hned za kurzorem");
  kv._m.delete(names[29]); seed(kv, T0 + 99999, "c", true); // nova davka mezi strankami
  const r3 = await get(kv, "&limit=10&cursor=" + r2.d.cursor);
  ok(r3.d.count === 10 && r3.d.items[0].ts === T0 + 9 * 1000 && r3.d.list_complete === true, "treti stranka = zbytek, nova davka ji nerozhodi");
}

console.log("\n" + pass + " OK, " + fail + " FAIL");
process.exit(fail ? 1 : 0);
