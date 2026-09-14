// Zkouska refund enginu proti podvrzenemu Payhipu/Stripu a podvrzenemu KV.
// Cil: overit, ze penize odejdou JEN kdyz maji, a ze se nikdy neodeslou dvakrat.
import { onRequest as refund } from "./_build/refund.mjs";
import { onRequest as hook } from "./_build/hook.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK   " + m); } else { fail++; console.log("  FAIL " + m); } };

function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    _m: m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }),
  };
}
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

// ---- podvrzeny svet ----
let W = {};
function world(over = {}) {
  W = Object.assign({
    licenseEnabled: true, licenseKnown: true,
    charges: [{ id: "ch_1", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, created: Math.floor((Date.now() - 2 * 86400000) / 1000), billing_details: { email: "a@b.com" } }],
    customers: [],
    refundFails: false,
    calls: [],
  }, over);
  globalThis.fetch = async (u, o = {}) => {
    u = String(u); W.calls.push((o.method || "GET") + " " + u.split("?")[0] + (o.headers && o.headers["Idempotency-Key"] ? " idem=" + o.headers["Idempotency-Key"] : ""));
    if (u.includes("/license/verify")) {
      if (!W.licenseKnown) return J({ data: null }, 200);
      return J({ data: { enabled: W.licenseEnabled } });
    }
    if (u.includes("/license/disable")) { W.licenseEnabled = false; return J({ ok: true }); }
    if (u.includes("/license/enable")) { W.licenseEnabled = true; return J({ ok: true }); }
    if (u.includes("/v1/customers/search")) return J({ data: W.customers });
    if (u.includes("/v1/charges/search")) return J({ data: [] });
    if (u.includes("/v1/charges")) return J({ data: W.charges, has_more: false });
    if (u.includes("/v1/refunds")) {
      if (W.refundFails) return J({ error: { message: "charge already refunded" } }, 402);
      return J({ id: "re_1", status: "succeeded" });
    }
    if (u.includes("discord")) return new Response("", { status: 204 });
    return J({ unmocked: u }, 500);
  };
}
const env = (kv, over = {}) => Object.assign({ FEEDBACK: kv, ADMIN_TOKEN: "T", PAYHIP_API_KEY: "K", STRIPE_SECRET_KEY: "sk_x" }, over);
const post = (body) => new Request("https://pitwise.net/api/refund", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4", "cf-ipcountry": "CZ" } });

async function seededKV(cfg, saleOver = {}) {
  const sale = Object.assign({ id: "S1", email: "a@b.com", price: 399, currency: "EUR", paymentType: "stripe", date: Date.now() - 2 * 86400000 }, saleOver);
  const h = (await sha("a@b.com")).slice(0, 24);
  return makeKV({ ["sale_S1"]: JSON.stringify(sale), ["idx_" + h]: JSON.stringify(["S1"]), cfg_refund: JSON.stringify(cfg) });
}
const tickets = async (kv) => {
  const out = [];
  for (const [k, v] of kv._m) if (k.startsWith("rq_")) out.push(JSON.parse(v));
  return out;
};
const didRefund = () => W.calls.some(c => c.includes("/v1/refunds"));

/* ===================== SCENARE ===================== */
console.log("\n1) DRY: najde platbu, ale penize NESMI odejit");
{
  world(); const kv = await seededKV({ mode: "dry" });
  const r = await refund({ request: post({ key: "LIC-1", email: "a@b.com", reason: "mic" }), env: env(kv) });
  const d = await r.json(); const t = (await tickets(kv))[0];
  ok(d.status === "pending", "zakaznikovi rekne 'pending' (dostal jsi " + d.status + ")");
  ok(t.status === "dry", "tiket ma stav dry");
  ok(!didRefund(), "NEVOLAL /v1/refunds");
  ok(!W.calls.some(c => c.includes("/license/disable")), "NEVYPNUL licenci");
  ok(/DRY RUN/.test(t.log.join(" ")), "log rika, co by udelal");
}

console.log("\n2) LIVE: vrati penize, vypne licenci, zapise do knihy");
{
  world(); const kv = await seededKV({ mode: "live" });
  const r = await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) });
  const d = await r.json(); const t = (await tickets(kv))[0];
  ok(d.status === "refunded", "zakaznik dostal 'refunded'");
  ok(t.amountCents === 399 && t.currency === "EUR", "castka z Stripu, ne z nasi knihy (" + t.amountCents + ")");
  ok(didRefund(), "zavolal /v1/refunds");
  ok(W.calls.some(c => c.includes("idem=pitwise-refund-S1")), "poslal klic idempotence");
  const order = W.calls.findIndex(c => c.includes("/license/disable")) < W.calls.findIndex(c => c.includes("/v1/refunds"));
  ok(order, "licence se vypla PRED odeslanim penez");
  ok(JSON.parse(kv._m.get("sale_S1")).refundedAt > 0, "kniha ma refund zapsany");
}

console.log("\n3) LIVE + Stripe odmitne: rollback licence, stav failed");
{
  world({ refundFails: true }); const kv = await seededKV({ mode: "live" });
  await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "failed", "stav failed");
  ok(W.licenseEnabled === true, "licence se vratila do provozu");
  ok(!JSON.parse(kv._m.get("sale_S1")).refundedAt, "kniha NEoznacila refund");
}

console.log("\n4) Dve platby na stejny e-mail: rucne, zadne penize");
{
  world({ charges: [
    { id: "ch_1", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, billing_details: { email: "a@b.com" } },
    { id: "ch_2", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, billing_details: { email: "a@b.com" } },
  ] });
  const kv = await seededKV({ mode: "live" });
  await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending", "stav pending");
  ok(!didRefund(), "zadny refund");
}

console.log("\n5) Uz vypnuta licence = uz refundovano");
{
  world({ licenseEnabled: false }); const kv = await seededKV({ mode: "live" });
  const d = await (await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) })).json();
  ok(d.status === "already_refunded", "odpoved already_refunded");
  ok(!didRefund(), "zadny refund");
}

console.log("\n6) Neznamy klic = 403 a zadne penize");
{
  world({ licenseKnown: false }); const kv = await seededKV({ mode: "live" });
  const r = await refund({ request: post({ key: "XXX", email: "a@b.com" }), env: env(kv) });
  ok(r.status === 403, "HTTP 403 (dostal jsi " + r.status + ")");
  ok(!didRefund(), "zadny refund");
}

console.log("\n7) Idempotence: druha zadost na uz vraceny nakup");
{
  world(); const kv = await seededKV({ mode: "live" });
  await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) });
  const first = W.calls.filter(c => c.includes("/v1/refunds")).length;
  W.licenseEnabled = true;                       // jako by klic nekdo znovu zapnul
  await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) });
  const second = W.calls.filter(c => c.includes("/v1/refunds")).length;
  ok(first === 1 && second === 1, "refund se zavolal jen jednou (" + first + " -> " + second + ")");
  ok((await tickets(kv)).some(t => t.status === "already"), "druhy tiket ma stav already");
}

console.log("\n8) Mimo 14denni okno: rucni fronta, procesor se vubec nevola");
{
  world(); const kv = await seededKV({ mode: "live", windowDays: 14 }, { date: Date.now() - 40 * 86400000 });
  await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending", "pending");
  ok(!W.calls.some(c => c.includes("api.stripe.com")), "Stripe se ani neptal");
  ok(/okno 14/.test(t.log.join(" ")), "log vysvetluje proc");
}

console.log("\n9) Denni strop vycerpan");
{
  world(); const kv = await seededKV({ mode: "live", dailyCap: 1 });
  kv._m.set("rq_" + Date.now() + "_aaa", JSON.stringify({ ts: Date.now(), status: "refunded", log: [] }));
  await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) });
  const t = (await tickets(kv)).find(x => x.email === "a@b.com");
  ok(t.status === "pending", "pending");
  ok(!didRefund(), "zadny refund");
}

console.log("\n10) Rucni schvaleni z adminu obejde okno, ale ne hledani platby");
{
  world(); const kv = await seededKV({ mode: "live", windowDays: 14 }, { date: Date.now() - 40 * 86400000 });
  await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) });
  const key = [...kv._m.keys()].find(k => k.startsWith("rq_"));
  const r = await refund({ request: new Request("https://pitwise.net/api/refund?token=T&action=approve&id=" + key, { method: "PUT" }), env: env(kv) });
  const d = await r.json();
  ok(d.status === "refunded", "po schvaleni vraceno (" + d.status + ")");
  ok(didRefund(), "refund opravdu odesel");
}

console.log("\n11) Admin bez tokenu se nedostane k nicemu");
{
  world(); const kv = await seededKV({ mode: "dry" });
  const g = await refund({ request: new Request("https://pitwise.net/api/refund?token=SPATNY"), env: env(kv) });
  const p = await refund({ request: new Request("https://pitwise.net/api/refund?action=config", { method: "PUT" }), env: env(kv) });
  ok(g.status === 401 && p.status === 401, "GET i PUT vraci 401");
}

console.log("\n12) Webhook: spatny podpis neprojde, spravny zalozi nakup + index");
{
  world(); const kv = makeKV();
  const sig = await sha("K");
  const mk = (b) => new Request("https://pitwise.net/api/payhip-hook", { method: "POST", body: JSON.stringify(b), headers: { "Content-Type": "application/json" } });
  const bad = await hook({ request: mk({ type: "paid", id: "S9", signature: "deadbeef", email: "c@d.com", price: 399 }), env: env(kv) });
  ok(bad.status === 401, "podvrh = 401");
  ok(kv._m.size === 0, "nic se neulozilo");
  const good = await hook({ request: mk({ type: "paid", id: "S9", signature: sig, email: "c@d.com", price: 399, currency: "eur", payment_type: "stripe", date: "2026-09-10 10:00:00" }), env: env(kv) });
  ok(good.status === 200, "platny webhook = 200");
  const sale = JSON.parse(kv._m.get("sale_S9"));
  ok(sale.price === 399 && sale.currency === "EUR", "ulozena cena a mena");
  ok(sale.date > 0 && new Date(sale.date).toISOString().startsWith("2026-09-10"), "datum rozparsovano (" + new Date(sale.date).toISOString().slice(0, 10) + ")");
  const h = (await sha("c@d.com")).slice(0, 24);
  ok(JSON.parse(kv._m.get("idx_" + h) || "[]").includes("S9"), "e-mailovy index zalozen");
  // a ted refund toho nakupu bez data v zadosti
  world({ charges: [{ id: "ch_9", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, billing_details: { email: "c@d.com" } }] });
  kv._m.set("cfg_refund", JSON.stringify({ mode: "live" }));
  const d = await (await refund({ request: post({ key: "LIC-9", email: "c@d.com" }), env: env(kv) })).json();
  ok(d.status === "refunded", "nakup z webhooku jde rovnou refundovat (" + d.status + ")");
}

console.log("\n13) Rate limit: sesta zadost z jedne IP neprojde");
{
  world(); const kv = await seededKV({ mode: "off" });
  let last;
  for (let i = 0; i < 6; i++) last = await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) });
  ok(last.status === 429, "sesta = 429 (dostal jsi " + last.status + ")");
}

console.log("\n14) Bez klice procesora se penize nikdy nepohnou");
{
  world(); const kv = await seededKV({ mode: "live" });
  const e = env(kv); delete e.STRIPE_SECRET_KEY;
  await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: e });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending", "pending");
  ok(/zadny klic procesora/.test(t.log.join(" ")), "log to rika narovinu");
}

console.log("\n15) BEZ zaznamu v knize: stari se vezme z data platby u Stripu");
{
  world({ customers: [{ id: "cus_1" }], charges: [{ id: "ch_5", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, created: 1789140554, billing_details: { email: "nova@b.com" } }] });
  const kv = makeKV({ cfg_refund: JSON.stringify({ mode: "live", windowDays: 14 }) });
  const d = await (await refund({ request: post({ key: "LIC-5", email: "nova@b.com" }), env: env(kv) })).json();
  ok(d.status === "refunded", "vraceno i kdyz nakup v knize neni (" + d.status + ")");
  const t = (await tickets(kv))[0];
  ok(/stari overeno podle platby/.test(t.log.join(" ")), "log rika, ze stari vzal z platby");
  ok(didRefund(), "refund odesel");
}

console.log("\n16) BEZ zaznamu v knize + stara platba: rucni fronta, zadne penize");
{
  world({ customers: [{ id: "cus_1" }], charges: [{ id: "ch_6", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, created: 1784215754, billing_details: { email: "stary@b.com" } }] });
  const kv = makeKV({ cfg_refund: JSON.stringify({ mode: "live", windowDays: 14 }) });
  await refund({ request: post({ key: "LIC-6", email: "stary@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending", "pending (" + t.status + ")");
  ok(!didRefund(), "zadny refund");
  ok(/60 dni stara/.test(t.log.join(" ")), "log uvadi stari platby");
}

console.log("\n17) BEZ zaznamu v knize + platba bez data: rucni fronta");
{
  world({ customers: [{ id: "cus_1" }], charges: [{ id: "ch_7", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, billing_details: { email: "bezdata@b.com" } }] });
  const kv = makeKV({ cfg_refund: JSON.stringify({ mode: "live", windowDays: 14 }) });
  await refund({ request: post({ key: "LIC-7", email: "bezdata@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending", "pending (" + t.status + ")");
  ok(!didRefund(), "radeji nevrati nic, nez aby hadal stari");
}

console.log("\n18) BEZ zaznamu v knize: strop plati dal");
{
  world({ customers: [{ id: "cus_1" }], charges: [{ id: "ch_8", amount: 4900, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, created: 1789313354, billing_details: { email: "drahy@b.com" } }] });
  const kv = makeKV({ cfg_refund: JSON.stringify({ mode: "live", windowDays: 14, maxCents: 600 }) });
  await refund({ request: post({ key: "LIC-8", email: "drahy@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending", "49 EUR nad stropem 6 EUR -> pending");
  ok(!didRefund(), "zadny refund");
}

console.log("\n=================================");
console.log(pass + " proslo, " + fail + " selhalo");
process.exit(fail ? 1 : 0);
