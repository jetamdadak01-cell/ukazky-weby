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
const DAY = 86400000;
const ago = (days) => Math.floor((Date.now() - days * DAY) / 1000);          // Stripe "created" (sekundy)
// platba tak, jak ji zaklada Payhip: host gcus_, e-mail JEN v description, billing/receipt prazdne
const guestCharge = (id, email, over = {}) => Object.assign({
  id, amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true,
  created: ago(1), customer: "gcus_" + id, description: email, receipt_email: null,
  billing_details: { email: null, name: "Guest Buyer" },
}, over);
const noise = (n, days, prefix = "ch_n") => Array.from({ length: n }, (_, i) =>
  guestCharge(prefix + i, "cizi" + i + "@jinde.cz", { created: ago(days) - i }));

let W = {};
function world(over = {}) {
  W = Object.assign({
    licenseEnabled: true, licenseKnown: true,
    charges: [{ id: "ch_1", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, created: ago(2), billing_details: { email: "a@b.com" } }],
    customers: [],
    ppTx: [],
    refundFails: false,
    calls: [], urls: [], bodies: [],
  }, over);
  globalThis.fetch = async (u, o = {}) => {
    u = String(u); W.urls.push(u);
    W.calls.push((o.method || "GET") + " " + u.split("?")[0] + (o.headers && o.headers["Idempotency-Key"] ? " idem=" + o.headers["Idempotency-Key"] : ""));
    if (o.body) W.bodies.push(String(o.body));
    const q = new URL(u).searchParams;
    if (u.includes("/license/verify")) {
      if (!W.licenseKnown) return J({ data: null }, 200);
      return J({ data: Object.assign({ enabled: W.licenseEnabled }, W.licenseOwner ? { buyer_email: W.licenseOwner } : {}) });
    }
    if (u.includes("/license/disable")) { W.licenseEnabled = false; return J({ ok: true }); }
    if (u.includes("/license/enable")) { W.licenseEnabled = true; return J({ ok: true }); }
    // Stripe jako opravdu: hledani zakazniku NEVIDI hosty gcus_
    if (u.includes("/v1/customers/search")) return J({ data: W.customers.filter(c => !String(c.id).startsWith("gcus_")) });
    if (u.includes("/v1/charges/search")) return J({ data: [] });
    if (u.includes("/v1/charges")) {
      // vypis jako Stripe: filtr created[gte]/[lte] + customer, nejnovejsi prvni, strankovani starting_after
      const gte = q.get("created[gte]"), lte = q.get("created[lte]"), cust = q.get("customer");
      const lim = Math.min(100, +(q.get("limit") || 10));
      let rows = W.charges.filter(c =>
        (c.created == null || ((gte == null || c.created >= +gte) && (lte == null || c.created <= +lte))) &&
        (!cust || c.customer === cust));
      rows = rows.slice().sort((a, b) => (b.created ?? Infinity) - (a.created ?? Infinity));
      let start = 0;
      if (q.get("starting_after")) start = rows.findIndex(c => c.id === q.get("starting_after")) + 1;
      return J({ data: rows.slice(start, start + lim), has_more: start + lim < rows.length });
    }
    if (u.includes("/v1/refunds")) {
      if (W.refundFails) return J({ error: { message: "charge already refunded" } }, 402);
      return J({ id: "re_1", status: "succeeded" });
    }
    // PayPal
    if (u.includes("/v1/oauth2/token")) return J({ access_token: "ppt" });
    if (u.includes("/v1/reporting/transactions")) {
      const pd = (s) => Date.parse(String(s).replace(/-0000$/, "Z"));
      const from = pd(q.get("start_date")), to = pd(q.get("end_date"));
      return J(Object.assign({ transaction_details: W.ppTx.filter(x => { const d = Date.parse(x.transaction_info.transaction_initiation_date); return d >= from && d <= to; }) }, W.ppPages ? { total_pages: W.ppPages } : {}));
    }
    if (u.includes("/v2/payments/captures/")) return J({ id: "pp_re_1", status: "COMPLETED" });
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
  // platba u Stripu je stejne stara jako nakup v knize (40 dni)
  world({ charges: [{ id: "ch_1", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, created: ago(40), billing_details: { email: "a@b.com" } }] });
  const kv = await seededKV({ mode: "live", windowDays: 14 }, { date: Date.now() - 40 * 86400000 });
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
  // datum nakupu = predevcirem v 10:00 (driv tu bylo napevno 2026-09-10 a test po 14 dnech "zestarl")
  const buyDay = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
  const good = await hook({ request: mk({ type: "paid", id: "S9", signature: sig, email: "c@d.com", price: 399, currency: "eur", payment_type: "stripe", date: buyDay + " 10:00:00" }), env: env(kv) });
  ok(good.status === 200, "platny webhook = 200");
  const sale = JSON.parse(kv._m.get("sale_S9"));
  ok(sale.price === 399 && sale.currency === "EUR", "ulozena cena a mena");
  ok(sale.date > 0 && new Date(sale.date).toISOString().startsWith(buyDay), "datum rozparsovano (" + new Date(sale.date).toISOString().slice(0, 10) + ")");
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
  world({ customers: [{ id: "cus_1" }], charges: [{ id: "ch_5", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, created: ago(2), customer: "cus_1", billing_details: { email: "nova@b.com" } }] });
  const kv = makeKV({ cfg_refund: JSON.stringify({ mode: "live", windowDays: 14 }) });
  const d = await (await refund({ request: post({ key: "LIC-5", email: "nova@b.com" }), env: env(kv) })).json();
  ok(d.status === "refunded", "vraceno i kdyz nakup v knize neni (" + d.status + ")");
  const t = (await tickets(kv))[0];
  ok(/stari overeno podle platby/.test(t.log.join(" ")), "log rika, ze stari vzal z platby");
  ok(didRefund(), "refund odesel");
}

console.log("\n16) BEZ zaznamu v knize + stara platba: rucni fronta, zadne penize");
{
  world({ customers: [{ id: "cus_1" }], charges: [{ id: "ch_6", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, created: ago(60), customer: "cus_1", billing_details: { email: "stary@b.com" } }] });
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
  world({ customers: [{ id: "cus_1" }], charges: [{ id: "ch_8", amount: 4900, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, created: ago(1), customer: "cus_1", billing_details: { email: "drahy@b.com" } }] });
  const kv = makeKV({ cfg_refund: JSON.stringify({ mode: "live", windowDays: 14, maxCents: 600 }) });
  await refund({ request: post({ key: "LIC-8", email: "drahy@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending", "49 EUR nad stropem 6 EUR -> pending");
  ok(!didRefund(), "zadny refund");
}

/* ===== Payhip host (gcus_): e-mail jen v description, hledani zakaznika vraci 0 ===== */
const noBook = (cfg) => makeKV({ cfg_refund: JSON.stringify(Object.assign({ mode: "live", windowDays: 14, maxCents: 900 }, cfg)) });
const stripeCalls = () => W.calls.filter(c => c.includes("api.stripe.com"));

console.log("\n19) HOST gcus_ bez knihy: platba se najde podle e-mailu v description a vrati se");
{
  world({ charges: [...noise(30, 1), guestCharge("ch_g1", "Guest.Buyer@Example.com", { amount: 483, created: ago(1) }), ...noise(20, 5, "ch_m")] });
  const kv = noBook();
  const d = await (await refund({ request: post({ key: "LIC-G1", email: "guest.buyer@example.com" }), env: env(kv) })).json();
  const t = (await tickets(kv))[0];
  ok(d.status === "refunded", "vraceno (" + d.status + ") | " + t.log.join(" | "));
  ok(t.paymentId === "ch_g1" && t.amountCents === 483 && t.currency === "EUR", "spravna platba a castka z Stripu (" + t.paymentId + ", " + t.amountCents + ")");
  ok(W.bodies.some(b => b.includes("charge=ch_g1")), "refund poslan na ch_g1");
  ok(/e-mail v platbe/.test(t.log.join(" ")), "log rika, jak ji nasel");
  const lic = W.calls.findIndex(c => c.includes("/license/disable")), money = W.calls.findIndex(c => c.includes("/v1/refunds"));
  ok(lic >= 0 && lic < money, "licence vypnuta PRED penezi");
  ok(stripeCalls().every(c => /^GET https:\/\/api\.stripe\.com\/v1\/charges$/.test(c) || /^POST https:\/\/api\.stripe\.com\/v1\/refunds/.test(c)),
    "volal jen GET /v1/charges a POST /v1/refunds (prava rk_: Charges + Refunds) -> " + [...new Set(stripeCalls().map(c => c.split(" idem")[0]))].join(", "));
  ok(!W.calls.some(c => c.includes("/v1/customers")), "na hledani zakaznika vubec nedoslo");
}

console.log("\n20) HOST gcus_ s nakupem v knize: najde se v okne +-2 dny od data nakupu");
{
  world({ charges: [guestCharge("ch_g2", "a@b.com", { created: ago(2) }), ...noise(10, 2)] });
  const kv = await seededKV({ mode: "live" });
  const d = await (await refund({ request: post({ key: "LIC-1", email: "a@b.com" }), env: env(kv) })).json();
  const t = (await tickets(kv))[0];
  ok(d.status === "refunded" && t.paymentId === "ch_g2", "vraceno pres ch_g2 (" + d.status + ", " + t.paymentId + ")");
  ok(/e-mail \+ datum nakupu/.test(t.log.join(" ")), "nalezeno podle e-mailu + data z knihy");
  ok(JSON.parse(kv._m.get("sale_S1")).refundedAt > 0, "kniha ma refund zapsany");
}

console.log("\n21) HOST: dve nevracene platby na stejny e-mail v okne -> rucne, zadne penize (ani PayPal)");
{
  world({
    charges: [guestCharge("ch_d1", "dva@b.com", { created: ago(1) }), guestCharge("ch_d2", "dva@b.com", { created: ago(4) }), ...noise(5, 2)],
    ppTx: [{ transaction_info: { transaction_id: "PP1", transaction_amount: { value: "3.99", currency_code: "EUR" }, transaction_initiation_date: new Date(Date.now() - 2 * DAY).toISOString() }, payer_info: { email_address: "dva@b.com" } }],
  });
  const kv = noBook();
  await refund({ request: post({ key: "LIC-D", email: "dva@b.com" }), env: env(kv, { PAYPAL_CLIENT_ID: "x", PAYPAL_SECRET: "y" }) });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending", "pending (" + t.status + ")");
  ok(!didRefund() && !W.calls.some(c => c.includes("/captures/")), "zadny refund ani u Stripu, ani u PayPalu");
  ok(/2 nevracenych plateb/.test(t.log.join(" ")) && /ch_d1/.test(t.log.join(" ")) && /ch_d2/.test(t.log.join(" ")), "log jmenuje obe platby");
  ok(!W.calls.some(c => c.includes("paypal.com")), "PayPal se po nejednoznacnem Stripu uz nezkousi");
}

console.log("\n22) HOST: platba uz vracena (cele i castecne) -> rucne, nikdy podruhe");
{
  for (const [label, over] of [["cele", { refunded: true, amount_refunded: 399 }], ["castecne", { refunded: false, amount_refunded: 100 }]]) {
    world({ charges: [guestCharge("ch_r1", "vraceno@b.com", Object.assign({ created: ago(3) }, over)), ...noise(5, 1)] });
    const kv = noBook();
    await refund({ request: post({ key: "LIC-R", email: "vraceno@b.com" }), env: env(kv) });
    const t = (await tickets(kv))[0];
    ok(t.status === "pending", label + ": pending (" + t.status + ")");
    ok(!didRefund(), label + ": zadny refund");
    ok(!W.calls.some(c => c.includes("/license/disable")), label + ": licence se nevypinala");
    ok(/uz je vracena/.test(t.log.join(" ")), label + ": log rika, ze uz je vracena");
  }
}

console.log("\n23) HOST mimo okno -> rucne, zadne penize");
{
  // a) 15 dni: v hledani (okno 14 + 2 dny rezervy) se najde, ale stari ji posle cloveku
  world({ charges: [guestCharge("ch_o1", "pozde@b.com", { created: ago(15) }), ...noise(5, 1)] });
  let kv = noBook();
  await refund({ request: post({ key: "LIC-O", email: "pozde@b.com" }), env: env(kv) });
  let t = (await tickets(kv))[0];
  ok(t.status === "pending" && !didRefund(), "15 dni: pending, zadny refund (" + t.status + ")");
  ok(/15 dni stara \(okno 14 dni\)/.test(t.log.join(" ")), "15 dni: log uvadi stari platby");
  // b) 40 dni: mimo hledane obdobi uplne
  world({ charges: [guestCharge("ch_o2", "pozde@b.com", { created: ago(40) }), ...noise(5, 1)] });
  kv = noBook();
  await refund({ request: post({ key: "LIC-O", email: "pozde@b.com" }), env: env(kv) });
  t = (await tickets(kv))[0];
  ok(t.status === "pending" && !didRefund(), "40 dni: pending, zadny refund (" + t.status + ")");
  ok(/poslednich 16 dni/.test(t.log.join(" ")), "40 dni: log rika, kde hledal");
  ok(W.urls.some(u => u.includes("/v1/charges?") && u.includes("created%5Bgte%5D=")), "vypis plateb byl omezeny datem");
}

console.log("\n24) HOST: podobny e-mail (xa@b.com vs a@b.com) se NESMI splest");
{
  world({ charges: [guestCharge("ch_x1", "xa@b.com", { created: ago(1) }), guestCharge("ch_x2", "Order a@b.com.au", { created: ago(1) })] });
  const kv = noBook();
  await refund({ request: post({ key: "LIC-X", email: "a@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending" && !didRefund(), "pending, zadny refund (" + t.status + ")");
}

console.log("\n25) HOST: platba az na druhe strance vypisu (strankovani)");
{
  world({ charges: [...noise(150, 0.5), guestCharge("ch_p2", "strana2@b.com", { created: ago(3) })] });
  const kv = noBook({ mode: "dry" });
  await refund({ request: post({ key: "LIC-P", email: "strana2@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "dry" && t.paymentId === "ch_p2", "nalezena ch_p2 (" + t.status + ", " + t.paymentId + ")");
  ok(W.urls.some(u => u.includes("starting_after=")), "sel na dalsi stranku");
  ok(!didRefund(), "DRY: zadne penize");
}

console.log("\n26) HOST: vypis delsi nez strop stranek -> jedinecnost nejde overit -> rucne");
{
  world({ charges: [guestCharge("ch_t1", "hodne@b.com", { created: ago(0.1) }), ...noise(1050, 1)] });
  const kv = noBook();
  await refund({ request: post({ key: "LIC-T", email: "hodne@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending" && !didRefund(), "pending, zadny refund (" + t.status + ")");
  ok(/delsi nez 1000/.test(t.log.join(" ")), "log vysvetluje proc");
  ok(stripeCalls().filter(c => c.includes("/v1/charges")).length <= 10, "nejvys 10 stranek (" + stripeCalls().filter(c => c.includes("/v1/charges")).length + ")");
}

console.log("\n27) HOST mimo okno + rucni schvaleni z adminu: najde se (180 dni) a vrati");
{
  world({ charges: [guestCharge("ch_a1", "stary.host@b.com", { created: ago(40) }), ...noise(5, 1)] });
  const kv = noBook();
  await refund({ request: post({ key: "LIC-A", email: "stary.host@b.com" }), env: env(kv) });
  ok((await tickets(kv))[0].status === "pending" && !didRefund(), "automaticky ne (mimo okno)");
  const key = [...kv._m.keys()].find(k => k.startsWith("rq_"));
  const d = await (await refund({ request: new Request("https://pitwise.net/api/refund?token=T&action=approve&id=" + key, { method: "PUT" }), env: env(kv) })).json();
  ok(d.status === "refunded" && W.bodies.some(b => b.includes("charge=ch_a1")), "po schvaleni vraceno pres ch_a1 (" + d.status + ")");
}

console.log("\n28) Skutecny zakaznik cus_ bez e-mailu na platbe: zalozni hledani zakaznika funguje dal");
{
  world({ customers: [{ id: "cus_9" }], charges: [{ id: "ch_c9", amount: 399, currency: "eur", status: "succeeded", refunded: false, amount_refunded: 0, paid: true, created: ago(2), customer: "cus_9", billing_details: { email: null } }] });
  const kv = noBook({ mode: "dry" });
  await refund({ request: post({ key: "LIC-C", email: "zakaznik@b.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "dry" && t.paymentId === "ch_c9", "nalezeno pres zakaznika (" + t.status + ")");
  ok(/zakaznik podle e-mailu/.test(t.log.join(" ")), "log to rika");
}

console.log("\n29) PayPal bez knihy: cerstvy nakup (pred 3 dny) se najde (driv hledal jen 12.-18. den zpet)");
{
  world({
    charges: [],
    ppTx: [{ transaction_info: { transaction_id: "PP3", transaction_amount: { value: "3.99", currency_code: "EUR" }, transaction_initiation_date: new Date(Date.now() - 3 * DAY).toISOString() }, payer_info: { email_address: "pp@b.com" } }],
  });
  const kv = noBook({ mode: "dry" });
  const e = env(kv, { PAYPAL_CLIENT_ID: "x", PAYPAL_SECRET: "y" }); delete e.STRIPE_SECRET_KEY;
  await refund({ request: post({ key: "LIC-PP", email: "pp@b.com" }), env: e });
  const t = (await tickets(kv))[0];
  ok(t.status === "dry" && t.paymentId === "PP3" && t.amountCents === 399, "nalezeno PP3 (" + t.status + ", " + t.paymentId + ")");
  ok(!W.calls.some(c => c.includes("/captures/")), "DRY: zadne penize");
}

console.log("\n30) Klic patri JINEMU e-mailu (cizi platba hosta) -> rucne, zadne penize, licence netknuta");
{
  world({ licenseOwner: "pravy.majitel@b.com", charges: [guestCharge("ch_v1", "obet@b.com", { created: ago(1) }), ...noise(5, 1)] });
  const kv = noBook();
  const d = await (await refund({ request: post({ key: "LIC-CIZI", email: "obet@b.com" }), env: env(kv) })).json();
  const t = (await tickets(kv))[0];
  ok(d.status === "pending" && t.status === "pending", "pending (" + t.status + ")");
  ok(!didRefund(), "NEVOLAL /v1/refunds");
  ok(!W.calls.some(c => c.includes("/license/disable")), "licenci nevypnul");
  ok(/patri jinemu e-mailu/.test(t.log.join(" ")) && !/pravy\.majitel/.test(t.log.join(" ")), "log to rika a e-mail majitele maskuje");
  // rucni schvaleni z adminu po kontrole clovekem projde
  const key = [...kv._m.keys()].find(k => k.startsWith("rq_"));
  const a = await (await refund({ request: new Request("https://pitwise.net/api/refund?token=T&action=approve&id=" + key, { method: "PUT" }), env: env(kv) })).json();
  ok(a.status === "refunded" && W.bodies.some(b => b.includes("charge=ch_v1")), "po rucnim schvaleni vraceno (" + a.status + ")");
}

console.log("\n31) Klic patri STEJNEMU e-mailu (jina velikost pismen) -> automaticky vraceno jako driv");
{
  world({ licenseOwner: "Guest.Buyer@Example.com", charges: [guestCharge("ch_s1", "guest.buyer@example.com", { created: ago(1) }), ...noise(5, 1)] });
  const kv = noBook();
  const d = await (await refund({ request: post({ key: "LIC-OK", email: "guest.buyer@example.com" }), env: env(kv) })).json();
  ok(d.status === "refunded", "vraceno (" + d.status + ")");
}

console.log("\n32) Apostrof v e-mailu: o'brien@x.com NESMI sedet na zadost brien@x.com");
{
  world({ charges: [guestCharge("ch_ob", "o'brien@x.com", { created: ago(1) }), ...noise(5, 1)] });
  const kv = noBook();
  await refund({ request: post({ key: "LIC-OB", email: "brien@x.com" }), env: env(kv) });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending" && !didRefund(), "pending, zadny refund (" + t.status + ")");
  // a o'brien sam svou platbu najde
  world({ charges: [guestCharge("ch_ob2", "o'brien@x.com", { created: ago(1) }), ...noise(5, 1)] });
  const kv2 = noBook({ mode: "dry" });
  await refund({ request: post({ key: "LIC-OB2", email: "o'brien@x.com" }), env: env(kv2) });
  const t2 = (await tickets(kv2))[0];
  ok(t2.status === "dry" && t2.paymentId === "ch_ob2", "o'brien najde svou platbu (" + t2.status + ", " + t2.paymentId + ")");
}

console.log("\n33) PayPal: vypis ma vic stranek -> jedinecnost nejde overit -> rucne");
{
  world({
    charges: [], ppPages: 2,
    ppTx: [{ transaction_info: { transaction_id: "PP9", transaction_amount: { value: "3.99", currency_code: "EUR" }, transaction_initiation_date: new Date(Date.now() - 2 * DAY).toISOString() }, payer_info: { email_address: "pp2@b.com" } }],
  });
  const kv = noBook();
  const e = env(kv, { PAYPAL_CLIENT_ID: "x", PAYPAL_SECRET: "y" }); delete e.STRIPE_SECRET_KEY;
  await refund({ request: post({ key: "LIC-PP2", email: "pp2@b.com" }), env: e });
  const t = (await tickets(kv))[0];
  ok(t.status === "pending" && !W.calls.some(c => c.includes("/captures/")), "pending, zadne penize (" + t.status + ")");
  ok(/2 stranek/.test(t.log.join(" ")), "log vysvetluje proc");
}

console.log("\n34) Stripe vrati 200 bez JSON -> tiket se ulozi do rucni fronty (zadny pad)");
{
  world({ charges: [] });
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, o = {}) => (String(u).includes("api.stripe.com/v1/charges") ? new Response("<html>oops</html>", { status: 200 }) : orig(u, o));
  const kv = noBook();
  let threw = false;
  try { await refund({ request: post({ key: "LIC-N", email: "nul@b.com" }), env: env(kv) }); } catch (e) { threw = true; }
  const t = (await tickets(kv))[0];
  ok(!threw && t && t.status === "pending", "zadna vyjimka, tiket pending (" + (t && t.status) + ")");
}

console.log("\n=================================");
console.log(pass + " proslo, " + fail + " selhalo");
process.exit(fail ? 1 : 0);
