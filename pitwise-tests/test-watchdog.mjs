import { onRequest as wd } from "./_build/watchdog.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK   " + m); } else { fail++; console.log("  FAIL " + m); } };
function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { _m: m,
    get: async k => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async k => { m.delete(k); },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }) };
}
let sent = [];
globalThis.fetch = async (u, o) => { sent.push(JSON.parse(o.body).content); return new Response("", { status: 204 }); };
const env = kv => ({ FEEDBACK: kv, ADMIN_TOKEN: "T", DISCORD_WEBHOOK: "https://discord.test/x" });
const run = (kv, q = "") => wd({ request: new Request("https://pitwise.net/api/watchdog?token=T" + q), env: env(kv) });

const now = Date.now();
const errBatch = (ts, ver, aid, msgs, src) => [["err_" + ts + "_a" + aid], JSON.stringify({ ts, ver, aid, country: "CZ", items: msgs.map(m => ({ at: "x", src: src || "mic", msg: m })) })];

console.log("\n1) Prvni beh: spocita chyby a posle hlaseni");
{
  const kv = makeKV(Object.fromEntries([
    errBatch(now - 3600e3, "2.26.3", "p1", ["mic err=silent peak=4", "mic err=empty"]),
    errBatch(now - 7200e3, "2.26.3", "p2", ["whisper-cli blocked by application control"]),
    [["fb_" + (now - 1000)], JSON.stringify({ ts: now - 1000, message: "the engineer doesnt hear me", country: "PL" })],
  ].map(([k, v]) => [k[0], v])));
  sent = [];
  const d = await (await run(kv)).json();
  ok(d.errors === 3, "3 radky chyb (" + d.errors + ")");
  ok(d.byCategory.mikrofon === 3, "vsechny 3 jsou mikrofon (" + JSON.stringify(d.byCategory) + ")");
  ok(d.people.mikrofon === 2, "od 2 lidi (" + d.people.mikrofon + ")");
  ok(d.feedback === 1, "1 feedback");
  ok(sent.length === 1 && /mikrofon/.test(sent[0]), "Discord dostal zpravu s kategorii");
  ok(!!kv._m.get("wd_last"), "otisk ulozen");
}

console.log("\n2) Druhy beh bez novinek: nic se neposila");
{
  const kv = makeKV({ wd_last: JSON.stringify({ ts: now - 1000, cats: { mikrofon: 3 }, vers: { "2.26.3": 2 } }) });
  sent = [];
  const d = await (await run(kv)).json();
  ok(d.errors === 0 && sent.length === 0, "zadna chyba, zadna zprava");
  const d2 = await (await run(kv, "&always=1")).json();
  ok(sent.length === 1 && /Nic noveho/.test(sent[0]), "s always=1 posle 'Nic noveho'");
}

console.log("\n3) Novy druh chyby se pozna a zvyrazni");
{
  const kv = makeKV(Object.assign(
    { wd_last: JSON.stringify({ ts: now - 86400e3, cats: { mikrofon: 50 }, vers: { "2.26.3": 9 } }) },
    Object.fromEntries([errBatch(now - 60e3, "2.27.0", "p9", ["update failed 0xc0000142", "update download error", "unzip failed"], "upd")].map(([k, v]) => [k[0], v]))
  ));
  sent = [];
  const d = await (await run(kv)).json();
  ok(d.newCategories.includes("aktualizace"), "nova kategorie 'aktualizace' (" + JSON.stringify(d.newCategories) + ")");
  ok(d.newVersions.includes("2.27.0"), "vsimla si nove verze");
  ok(/NOVY DRUH CHYBY/.test(sent[0] || ""), "Discord to ma tucne");
}

console.log("\n4) Cekajici refundy a selhani maji prednost");
{
  const kv = makeKV({
    ["rq_" + (now - 5000) + "_a"]: JSON.stringify({ ts: now - 5000, status: "pending", log: [] }),
    ["rq_" + (now - 6000) + "_b"]: JSON.stringify({ ts: now - 6000, status: "failed", log: [] }),
  });
  sent = [];
  const d = await (await run(kv)).json();
  ok(d.refunds.pending === 1 && d.refunds.failed === 1, "spocitano 1+1");
  ok(/REFUND SELHAL/.test(sent[0]) && sent[0].indexOf("REFUND SELHAL") < sent[0].indexOf("Zadosti"), "selhani je uplne nahore");
}

console.log("\n5) dry=1 nic neposle a nepresune otisk");
{
  const kv = makeKV(Object.fromEntries([errBatch(now - 60e3, "2.26.3", "p1", ["mic err=silent"])].map(([k, v]) => [k[0], v])));
  sent = [];
  const d = await (await run(kv, "&dry=1")).json();
  ok(d.errors === 1, "spocitalo");
  ok(sent.length === 0, "neposlalo");
  ok(!kv._m.get("wd_last"), "otisk NEULOZEN (jde spustit znovu)");
}

console.log("\n6) Spatny token");
{
  const kv = makeKV();
  const r = await wd({ request: new Request("https://pitwise.net/api/watchdog?token=X"), env: env(kv) });
  ok(r.status === 401, "401");
}

console.log("\n=================================");
console.log(pass + " proslo, " + fail + " selhalo");
process.exit(fail ? 1 : 0);
