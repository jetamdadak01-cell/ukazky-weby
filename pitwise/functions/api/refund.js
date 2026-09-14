// Cloudflare Pages Function — AUTOMATICKE VRACENI PENEZ.
//   POST /api/refund                        -> zadost zakaznika (verejne, rate-limit 5/den/IP)
//   GET  /api/refund?token=XXX              -> tikety + konfigurace + statistika (admin)
//   PUT  /api/refund?token=XXX&action=...   -> config | approve | deny | delete (admin)
//
// PROC TAKHLE: Payhip API refund endpoint NEMA (pokryva jen kupony a licencni klice), takze
// penize se musi vratit u PROCESORA, pres ktery platba realne tekla - Stripe nebo PayPal.
// Vetev se vybira sama podle toho, ktery klic je vyplneny v Cloudflare (nastavit lze i oba).
//
// TRI POJISTKY, KTERE TU JSOU ZAMERNE:
//  1) REZIM (cfg.mode): off = jen fronta, dry = vsechno krome penez (napise, co by udelal),
//     live = realne vraci. Vychozi je "dry" - dokud majitel na jednom skutecnem pripadu
//     neuvidi, ze parovani plateb sedi, nesmi tenhle kod hybat s penezi.
//  2) PENIZE JEN PROTI SKUTECNE PLATBE. Payhip podepisuje webhooky konstantou sha256(API klic),
//     ne HMACem obsahu - falesny "paid" tedy jde podvrhnout. Proto se castka i existence platby
//     berou VZDY z odpovedi Stripe/PayPalu, nikdy z nasi KV knihy. Kdyz se platba nenajde
//     jednoznacne (0 nebo 2+ kandidatu), tiket jde do rucni fronty. Radeji rucne nez omylem.
//  3) PORADI: nejdriv se VYPNE LICENCE, teprve pak jdou penize. Kdyz refund selze, licence se
//     zase zapne. Nikdy tak nenastane stav "penize zpet + appka dal funguje".
//
// Vyzaduje: KV "FEEDBACK", env PAYHIP_API_KEY, ADMIN_TOKEN.
// Pro realne vraceni: STRIPE_SECRET_KEY  nebo  PAYPAL_CLIENT_ID + PAYPAL_SECRET.
// Volitelne: PAYHIP_PRODUCT (default mquCD), PAYHIP_PRODUCT_SECRET (novejsi API v2),
//            PAYPAL_ENV=sandbox, DISCORD_WEBHOOK.

const CFG_KEY = "cfg_refund";
const DEF_CFG = {
  mode: "dry",        // off | dry | live
  windowDays: 14,     // do kolika dnu od nakupu se vraci automaticky (0 = bez limitu)
  maxCents: 900,      // strop jedne vracene castky (produkt stoji 399 centu)
  dailyCap: 5,        // kolik automatickych refundu smi projit za 24 h (pojistka proti smycce)
};

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.FEEDBACK;
  const url = new URL(request.url);
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });

  if (!kv) return json({ ok: false, error: "KV not bound (FEEDBACK)" }, 500);
  const isAdmin = () => env.ADMIN_TOKEN && (url.searchParams.get("token") || "") === env.ADMIN_TOKEN;

  // ================= ADMIN: cteni =================
  if (request.method === "GET") {
    if (!isAdmin()) return json({ ok: false, error: "unauthorized" }, 401);
    const cfg = await getCfg(kv);
    const items = [];
    const list = await kv.list({ prefix: "rq_" });
    for (const k of list.keys) {
      const v = await kv.get(k.name);
      if (v) { try { const o = JSON.parse(v); o._key = k.name; o.key = mask(o.key, 4); items.push(o); } catch (e) {} }
    }
    items.sort((a, b) => b.ts - a.ts);
    const day = Date.now() - 86400000;
    return json({
      ok: true, cfg, count: items.length,
      pending: items.filter(i => i.status === "pending" || i.status === "dry").length,
      refunded24h: items.filter(i => i.status === "refunded" && i.ts > day).length,
      processors: { stripe: !!env.STRIPE_SECRET_KEY, paypal: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET) },
      items,
    });
  }

  // ================= ADMIN: akce =================
  if (request.method === "PUT") {
    if (!isAdmin()) return json({ ok: false, error: "unauthorized" }, 401);
    const action = url.searchParams.get("action") || "";

    if (action === "config") {
      let body = {}; try { body = await request.json(); } catch (e) {}
      const cfg = await getCfg(kv);
      if (["off", "dry", "live"].includes(body.mode)) cfg.mode = body.mode;
      if (Number.isFinite(+body.windowDays)) cfg.windowDays = Math.max(0, Math.min(3650, +body.windowDays));
      if (Number.isFinite(+body.maxCents)) cfg.maxCents = Math.max(0, Math.min(100000, +body.maxCents));
      if (Number.isFinite(+body.dailyCap)) cfg.dailyCap = Math.max(0, Math.min(100, +body.dailyCap));
      await kv.put(CFG_KEY, JSON.stringify(cfg));
      return json({ ok: true, cfg });
    }

    const id = url.searchParams.get("id") || "";
    if (!id.startsWith("rq_")) return json({ ok: false, error: "bad id" }, 400);
    let t = null; try { t = JSON.parse((await kv.get(id)) || "null"); } catch (e) {}
    if (!t) return json({ ok: false, error: "not found" }, 404);

    if (action === "delete") { await kv.delete(id); return json({ ok: true, deleted: id }); }
    if (action === "deny") {
      t.status = "denied"; t.log.push(stamp("zamitnuto rucne v adminu"));
      await kv.put(id, JSON.stringify(t)); return json({ ok: true, status: t.status });
    }
    if (action === "approve") {
      // rucni schvaleni obchazi POLITIKU (okno, strop), NE ale pojistku jednoznacne platby -
      // i tady musi byt u procesora prave jedna odpovidajici platba.
      const cfg = await getCfg(kv);
      const sale = t.saleId ? await getJSON(kv, "sale_" + t.saleId) : null;
      await processRefund(env, kv, t, sale, cfg, { forceLive: true, skipPolicy: true });
      await kv.put(id, JSON.stringify(t));
      return json({ ok: true, status: t.status, log: t.log });
    }
    return json({ ok: false, error: "bad action" }, 400);
  }

  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  // ================= VEREJNE: zadost zakaznika =================
  const ip = request.headers.get("cf-connecting-ip") || "0";
  const rlKey = "rlr_" + ip;
  let rlCnt = 0;
  try { rlCnt = parseInt((await kv.get(rlKey)) || "0", 10) || 0; } catch (e) {}
  if (rlCnt >= 5) return json({ ok: false, error: "rate limit" }, 429);
  try { await kv.put(rlKey, String(rlCnt + 1), { expirationTtl: 86400 }); } catch (e) {}

  let d = {}; try { d = await request.json(); } catch (e) {}
  const key = (d.key || "").toString().trim().slice(0, 80);
  const email = (d.email || "").toString().trim().toLowerCase().slice(0, 200);
  const reason = (d.reason || "").toString().slice(0, 1000).trim();
  if (!key) return json({ ok: false, error: "license key required" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: "valid email required" }, 400);

  const cfg = await getCfg(kv);
  const t = {
    ts: Date.now(), email, key, reason, ip,
    country: request.headers.get("cf-ipcountry") || "",
    status: "pending", log: [],
  };
  const tKey = "rq_" + t.ts + "_" + Math.random().toString(36).slice(2, 8);

  // --- 1) je ten klic vubec nas a zivy? ---
  const lic = await payhipVerify(env, key);
  if (!lic.ok) {
    t.status = "denied"; t.log.push(stamp("licencni klic Payhip neuznal (" + lic.why + ")"));
    await kv.put(tKey, JSON.stringify(t));
    return json({ ok: false, error: "This license key was not recognised. Copy it exactly as it appears in your Payhip receipt." }, 403);
  }
  if (lic.disabled) {
    // klic uz je vypnuty = Payhip ho vypnul pri svem vlastnim refundu, nebo jsme ho vypnuli my
    t.status = "already"; t.log.push(stamp("klic uz je vypnuty - refund uz probehl driv"));
    await kv.put(tKey, JSON.stringify(t));
    return json({ ok: true, status: "already_refunded", message: "This purchase has already been refunded." });
  }

  // --- 2) nakup z ucetni knihy (webhook /api/payhip-hook) ---
  const sales = await salesByEmail(kv, email);
  const sale = sales.filter(s => !s.refundedAt).sort((a, b) => (b.date || 0) - (a.date || 0))[0] || null;
  if (!sale && sales.length) {
    // Vsechny nakupy tohoto e-mailu uz v knize refund maji. Bez tohohle by se takova zadost
    // tvarila jako "neznamy nakup" a spadla do rucni fronty - clovek by pak resil neco,
    // co je davno vyresene. (Klic uz byva vypnuty, ale nekdo ho mohl rucne zapnout zpatky.)
    t.status = "already";
    t.log.push(stamp("vsechny nakupy tohoto e-mailu jsou v knize uz vracene"));
    await kv.put(tKey, JSON.stringify(t));
    await notify(env, t, tKey);
    return json({ ok: true, status: "already_refunded", message: "This purchase has already been refunded." });
  }
  if (sale) {
    t.saleId = sale.id;
    t.log.push(stamp("nakup v knize: " + fmtMoney(sale.price, sale.currency) + ", " + new Date(sale.date).toISOString().slice(0, 10) + ", " + (sale.paymentType || "?")));
    if (sale.refundRequested) t.log.push(stamp("POZOR: na tenhle nakup uz tiket existoval"));
  } else {
    t.log.push(stamp("v knize zadny nakup na tenhle e-mail (koupeno pred zavedenim webhooku?) - platba se bude hledat u procesora podle e-mailu"));
  }

  // --- 3) politika ---
  if (cfg.mode === "off") {
    t.log.push(stamp("rezim OFF - do rucni fronty"));
  } else {
    const pol = policy(sale, cfg);
    if (!pol.ok) t.log.push(stamp("politika: " + pol.why + " -> rucni fronta"));
    else {
      const capped = await overDailyCap(kv, cfg);
      if (capped) t.log.push(stamp("denni strop " + cfg.dailyCap + " refundu vycerpan -> rucni fronta"));
      else await processRefund(env, kv, t, sale, cfg, {});
    }
  }

  // --- 4) ulozit + oznamit ---
  if (sale && !sale.refundedAt) { sale.refundRequested = t.ts; try { await kv.put("sale_" + sale.id, JSON.stringify(sale)); } catch (e) {} }
  await kv.put(tKey, JSON.stringify(t));
  await notify(env, t, tKey);

  if (t.status === "refunded") {
    return json({ ok: true, status: "refunded", message: "Refunded " + fmtMoney(t.amountCents, t.currency) + " to your original payment method. Banks usually show it within 5-10 days. Your license key has been switched off." });
  }
  return json({ ok: true, status: "pending", message: "Your refund request was received. It is being handled manually and you will hear back by email." });
}

/* ========================= JADRO ========================= */

async function processRefund(env, kv, t, sale, cfg, opts) {
  const live = opts.forceLive ? true : cfg.mode === "live";

  // idempotence: uz vraceno?
  if (sale && sale.refundedAt) {
    t.status = "already"; t.log.push(stamp("kniha uz refund eviduje (" + new Date(sale.refundedAt).toISOString().slice(0, 10) + ")"));
    return;
  }

  // --- najit platbu u procesora (JEDNOZNACNE, jinak rucne) ---
  const pay = await findPayment(env, t, sale);
  if (!pay) { t.status = "pending"; return; }
  t.log.push(stamp("platba nalezena: " + pay.processor + " " + pay.id + " " + fmtMoney(pay.amountCents, pay.currency) + " (" + pay.how + ")"));

  if (!opts.skipPolicy && cfg.maxCents > 0 && pay.amountCents > cfg.maxCents) {
    t.status = "pending";
    t.log.push(stamp("castka " + fmtMoney(pay.amountCents, pay.currency) + " je nad stropem " + (cfg.maxCents / 100).toFixed(2) + " -> rucni fronta"));
    return;
  }

  t.processor = pay.processor; t.paymentId = pay.id;
  t.amountCents = pay.amountCents; t.currency = pay.currency;

  if (!live) {
    t.status = "dry";
    t.log.push(stamp("DRY RUN: tady bych vypnul licenci a vratil " + fmtMoney(pay.amountCents, pay.currency) + " pres " + pay.processor + ". Penize NEODESLANY (prepni rezim na LIVE)."));
    return;
  }

  // --- licence PRED penezi (rollback nize, kdyby refund selhal) ---
  const dis = await payhipLicense(env, t.key, "disable");
  t.log.push(stamp(dis.ok ? "licence vypnuta u Payhipu" : "licenci se NEPODARILO vypnout (" + dis.why + ") - pokracuji, refund ma prednost"));

  // --- penize ---
  const res = pay.processor === "stripe"
    ? await stripeRefund(env.STRIPE_SECRET_KEY, pay.id, t.saleId || t.ts)
    : await paypalRefund(env, pay.id, t.saleId || t.ts);

  if (!res.ok) {
    t.status = "failed";
    t.log.push(stamp("REFUND SELHAL: " + res.why));
    if (dis.ok) {
      const back = await payhipLicense(env, t.key, "enable");
      t.log.push(stamp(back.ok ? "licence vracena zpet do provozu (penize neodesly)" : "POZOR: licence zustala vypnuta a penize neodesly - sahni na to rucne"));
    }
    return;
  }

  t.status = "refunded";
  t.refundId = res.id || "";
  t.log.push(stamp("VRACENO " + fmtMoney(pay.amountCents, pay.currency) + " pres " + pay.processor + " (" + (res.id || "bez id") + ", stav " + (res.state || "?") + ")"));

  // zapis do ucetni knihy (Payhip o refundu u procesora sam nevi - jeho webhook nedorazi)
  if (sale) {
    sale.refundedAt = Date.now(); sale.refundedCents = pay.amountCents;
    sale.refundFull = sale.price > 0 ? pay.amountCents >= sale.price : true;
    sale.refundVia = pay.processor;
    try { await kv.put("sale_" + sale.id, JSON.stringify(sale)); } catch (e) {}
  }
}

// Politika: co smi projit bez cloveka.
function policy(sale, cfg) {
  if (!sale) return { ok: false, why: "neznamy nakup (nejde overit stari)" };
  if (cfg.windowDays > 0) {
    const days = (Date.now() - (sale.date || 0)) / 86400000;
    if (days > cfg.windowDays) return { ok: false, why: "nakup je " + Math.round(days) + " dni stary (okno " + cfg.windowDays + ")" };
  }
  if (cfg.maxCents > 0 && sale.price > cfg.maxCents) return { ok: false, why: "cena nad stropem" };
  return { ok: true };
}

async function overDailyCap(kv, cfg) {
  if (!cfg.dailyCap) return false;
  const since = Date.now() - 86400000;
  let n = 0;
  const list = await kv.list({ prefix: "rq_" });
  for (const k of list.keys) {
    const ts = parseInt((k.name.split("_")[1] || "0"), 10);
    if (ts < since) continue;                      // starsi tikety necteme vubec (setri subrequesty)
    const v = await kv.get(k.name);
    if (!v) continue;
    try { if (JSON.parse(v).status === "refunded") n++; } catch (e) {}
    if (n >= cfg.dailyCap) return true;
  }
  return false;
}

/* ========================= HLEDANI PLATBY ========================= */

async function findPayment(env, t, sale) {
  const around = sale && sale.date ? sale.date : 0;
  if (env.STRIPE_SECRET_KEY) {
    const r = await stripeFind(env.STRIPE_SECRET_KEY, t.email, around, t.log);
    if (r) return r;
  }
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET) {
    const r = await paypalFind(env, t.email, around, t.log);
    if (r) return r;
  }
  if (!env.STRIPE_SECRET_KEY && !env.PAYPAL_CLIENT_ID) t.log.push(stamp("zadny klic procesora v Cloudflare -> penize musi vratit clovek"));
  else t.log.push(stamp("platba se u procesora nenasla jednoznacne -> rucni fronta"));
  return null;
}

/* ---------- Stripe ---------- */
const chEmail = (c) => ((c.billing_details && c.billing_details.email) || c.receipt_email || (c.metadata && c.metadata.email) || "").toLowerCase();
const chUsable = (c) => c.status === "succeeded" && !c.refunded && !c.amount_refunded && c.paid !== false;

async function sGet(sk, path) {
  try {
    const r = await fetch("https://api.stripe.com" + path, { headers: { Authorization: "Bearer " + sk } });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { error: (j && j.error && j.error.message) || ("HTTP " + r.status) };
    return { data: j };
  } catch (e) { return { error: String(e).slice(0, 120) }; }
}

async function stripeFind(sk, email, aroundMs, log) {
  const em = (email || "").toLowerCase();
  const hit = (c, how) => ({ processor: "stripe", id: c.id, amountCents: c.amount, currency: (c.currency || "").toUpperCase(), how });

  // A) zname datum nakupu -> vypis plateb v okne +-2 dny (spolehlive, bez vyhledavaciho indexu)
  if (aroundMs) {
    const from = Math.floor((aroundMs - 2 * 86400000) / 1000), to = Math.floor((aroundMs + 2 * 86400000) / 1000);
    const r = await sGet(sk, "/v1/charges?limit=100&created%5Bgte%5D=" + from + "&created%5Blte%5D=" + to);
    if (r.error) log.push(stamp("Stripe vypis plateb selhal: " + r.error));
    else {
      const all = (r.data.data || []).filter(chUsable);
      const byEmail = all.filter(c => chEmail(c) === em);
      if (byEmail.length === 1) return hit(byEmail[0], "e-mail + datum nakupu");
      if (byEmail.length > 1) { log.push(stamp("Stripe: " + byEmail.length + " plateb na stejny e-mail v okne - nechavam cloveku")); return null; }
      log.push(stamp("Stripe: v okne +-2 dny zadna platba na " + em + (r.data.has_more ? " (a vypis byl oriznuty na 100)" : "")));
    }
  }

  // B) neznamy nakup -> zakaznik podle e-mailu a jeho platby
  //    (Stripe umi hledat e-mail jen u zakazniku, u plateb ne - proto tenhle dvoukrok)
  const cs = await sGet(sk, "/v1/customers/search?limit=10&query=" + encodeURIComponent('email:"' + em + '"'));
  if (cs.error) { log.push(stamp("Stripe hledani zakaznika selhalo: " + cs.error)); return null; }
  const custs = (cs.data.data || []);
  if (custs.length !== 1) { log.push(stamp("Stripe: e-mailu " + em + " odpovida " + custs.length + " zakazniku - nechavam cloveku")); return null; }
  const ch = await sGet(sk, "/v1/charges?limit=100&customer=" + encodeURIComponent(custs[0].id));
  if (ch.error) { log.push(stamp("Stripe vypis plateb zakaznika selhal: " + ch.error)); return null; }
  const usable = (ch.data.data || []).filter(chUsable);
  if (usable.length === 1) return hit(usable[0], "zakaznik podle e-mailu");
  log.push(stamp("Stripe: zakaznik ma " + usable.length + " nevracenych plateb - nechavam cloveku"));
  return null;
}

async function stripeRefund(sk, chargeId, idemSeed) {
  try {
    const r = await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + sk,
        "Content-Type": "application/x-www-form-urlencoded",
        // klic idempotence: i kdyby se pozadavek poslal dvakrat, Stripe vrati penize JEN JEDNOU
        "Idempotency-Key": "pitwise-refund-" + idemSeed,
      },
      body: new URLSearchParams({ charge: chargeId, reason: "requested_by_customer" }).toString(),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, why: (j && j.error && j.error.message) || ("HTTP " + r.status) };
    return { ok: true, id: j.id, state: j.status };
  } catch (e) { return { ok: false, why: String(e).slice(0, 140) }; }
}

/* ---------- PayPal ---------- */
const ppBase = (env) => (env.PAYPAL_ENV === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com");
const ppDate = (ms) => new Date(ms).toISOString().slice(0, 19) + "-0000";

async function ppToken(env) {
  try {
    const r = await fetch(ppBase(env) + "/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_SECRET), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.access_token) return { error: "oauth HTTP " + r.status };
    return { token: j.access_token };
  } catch (e) { return { error: String(e).slice(0, 120) }; }
}

async function paypalFind(env, email, aroundMs, log) {
  const tk = await ppToken(env);
  if (tk.error) { log.push(stamp("PayPal prihlaseni selhalo: " + tk.error)); return null; }
  // Reporting API umi max 31 dni na dotaz; bez data nakupu bereme okno kolem poslednich dvou tydnu.
  const center = aroundMs || (Date.now() - 15 * 86400000);
  const from = ppDate(Math.max(center - 3 * 86400000, Date.now() - 366 * 86400000));
  const to = ppDate(Math.min(center + 3 * 86400000, Date.now()));
  const u = ppBase(env) + "/v1/reporting/transactions?fields=transaction_info,payer_info&page_size=100&page=1"
    + "&transaction_status=S&start_date=" + encodeURIComponent(from) + "&end_date=" + encodeURIComponent(to);
  let j = null;
  try {
    const r = await fetch(u, { headers: { Authorization: "Bearer " + tk.token } });
    j = await r.json().catch(() => null);
    if (!r.ok) { log.push(stamp("PayPal vypis transakci selhal: HTTP " + r.status)); return null; }
  } catch (e) { log.push(stamp("PayPal vypis transakci selhal: " + String(e).slice(0, 100))); return null; }

  const em = (email || "").toLowerCase();
  const rows = (j && j.transaction_details) || [];
  const cands = rows.filter(x => {
    const pe = ((x.payer_info && x.payer_info.email_address) || "").toLowerCase();
    const amt = x.transaction_info && x.transaction_info.transaction_amount;
    return pe === em && amt && Math.round(Math.abs(parseFloat(amt.value)) * 100) > 0;
  });
  if (cands.length !== 1) { log.push(stamp("PayPal: e-mailu odpovida " + cands.length + " transakci - nechavam cloveku")); return null; }
  const ti = cands[0].transaction_info;
  return {
    processor: "paypal", id: ti.transaction_id,
    amountCents: Math.round(Math.abs(parseFloat(ti.transaction_amount.value)) * 100),
    currency: (ti.transaction_amount.currency_code || "").toUpperCase(),
    how: "e-mail platce" + (aroundMs ? " + datum nakupu" : " (okno bez data nakupu)"),
  };
}

async function paypalRefund(env, captureId, idemSeed) {
  const tk = await ppToken(env);
  if (tk.error) return { ok: false, why: tk.error };
  try {
    const r = await fetch(ppBase(env) + "/v2/payments/captures/" + encodeURIComponent(captureId) + "/refund", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + tk.token,
        "Content-Type": "application/json",
        "PayPal-Request-Id": "pitwise-refund-" + idemSeed,   // idempotence na strane PayPalu
      },
      body: "{}",                                            // prazdne telo = plna castka
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, why: (j && (j.message || (j.details && j.details[0] && j.details[0].description))) || ("HTTP " + r.status) };
    return { ok: true, id: j && j.id, state: j && j.status };
  } catch (e) { return { ok: false, why: String(e).slice(0, 140) }; }
}

/* ---------- Payhip licence ---------- */
async function payhipVerify(env, key) {
  try {
    const product = env.PAYHIP_PRODUCT || "mquCD";
    const r = await fetch("https://payhip.com/api/v1/license/verify?product_link=" + encodeURIComponent(product) + "&license_key=" + encodeURIComponent(key),
      { headers: { "payhip-api-key": env.PAYHIP_API_KEY || "" } });
    if (!r.ok) return { ok: false, why: "HTTP " + r.status };
    const j = await r.json().catch(() => null);
    if (!j || !j.data) return { ok: false, why: "klic neznamy" };
    return { ok: true, disabled: !j.data.enabled, data: j.data };
  } catch (e) { return { ok: false, why: String(e).slice(0, 100) }; }
}

async function payhipLicense(env, key, op) {
  try {
    let r;
    if (env.PAYHIP_PRODUCT_SECRET) {
      r = await fetch("https://payhip.com/api/v2/license/" + op, {
        method: "PUT",
        headers: { "product-secret-key": env.PAYHIP_PRODUCT_SECRET, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ license_key: key }).toString(),
      });
    } else {
      r = await fetch("https://payhip.com/api/v1/license/" + op, {
        method: "PUT",
        headers: { "payhip-api-key": env.PAYHIP_API_KEY || "", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ product_link: env.PAYHIP_PRODUCT || "mquCD", license_key: key }).toString(),
      });
    }
    if (!r.ok) return { ok: false, why: "HTTP " + r.status };
    return { ok: true };
  } catch (e) { return { ok: false, why: String(e).slice(0, 100) }; }
}

/* ========================= POMOCNE ========================= */
async function getCfg(kv) {
  let c = null; try { c = JSON.parse((await kv.get(CFG_KEY)) || "null"); } catch (e) {}
  return Object.assign({}, DEF_CFG, c || {});
}
async function getJSON(kv, k) { try { return JSON.parse((await kv.get(k)) || "null"); } catch (e) { return null; } }

async function salesByEmail(kv, email) {
  const h = await sha256hex(email.trim().toLowerCase());
  let ids = [];
  try { ids = JSON.parse((await kv.get("idx_" + h.slice(0, 24))) || "[]"); } catch (e) {}
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids.slice(-5)) {            // vic nez 5 nakupu na e-mail automaticky neresime
    const s = await getJSON(kv, "sale_" + id);
    if (s) out.push(s);
  }
  return out;
}

async function notify(env, t, tKey) {
  if (!env.DISCORD_WEBHOOK) return;
  const head = {
    refunded: "**AUTOMATICKY VRACENO**", dry: "**DRY RUN refundu** (penize neodesly)",
    pending: "**Zadost o refund - RUCNE**", failed: "**REFUND SELHAL**",
    denied: "**Zadost zamitnuta**", already: "Zadost o uz vraceny nakup",
  }[t.status] || t.status;
  const lines = [
    head + "  ·  " + mask(t.email) + (t.country ? " (" + t.country + ")" : ""),
    t.amountCents ? "Castka: " + fmtMoney(t.amountCents, t.currency) + (t.processor ? " / " + t.processor : "") : "",
    t.reason ? "Duvod: " + t.reason.slice(0, 300) : "Duvod neuveden",
    "Log: " + t.log.slice(-4).join(" | "),
    "Admin: https://pitwise.net/admin  (" + tKey + ")",
  ].filter(Boolean);
  try {
    await fetch(env.DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: lines.join("\n").slice(0, 1900) }),
    });
  } catch (e) {}
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const stamp = (s) => new Date().toISOString().slice(5, 16).replace("T", " ") + "  " + s;
const fmtMoney = (cents, cur) => ((cents || 0) / 100).toFixed(2) + " " + (cur || "");
function mask(s, tail) {
  s = (s || "").toString();
  if (tail) return s.length <= tail ? "***" : "***" + s.slice(-tail);
  const at = s.indexOf("@");
  return at < 1 ? (s || "?") : s.slice(0, Math.min(3, at)) + "***" + s.slice(at);
}
