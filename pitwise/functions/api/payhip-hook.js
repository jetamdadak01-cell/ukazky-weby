// Cloudflare Pages Function — Payhip webhook = ucetni kniha prodeju a refundu.
//   POST /api/payhip-hook              <- Payhip (Settings > Developer > webhook URL)
//   GET  /api/payhip-hook?token=XXX    -> prehled pro admin panel (prodeje + refundy)
// Udalosti: paid, refunded (subscription.* ignorujeme - PitWise je jednorazovy produkt).
//
// PROC TO EXISTUJE: bez teto knihy nevime o zakaznikovi NIC krome licencniho klice.
// /api/refund potrebuje vedet, kdy a za kolik clovek koupil, aby vubec mohl posoudit
// (a u procesora najit) vracenou platbu. Zaroven se tim refund promeni v data:
// v adminu jde refund sparovat s feedbackem a errlogem podle e-mailu a zeme.
//
// BEZPECNOST - CTI, NEZ TOMU ZACNES VERIT:
// Payhip "signature" NENI HMAC payloadu, je to jen sha256(API klic) - tedy KONSTANTA,
// stejna ve vsech webhoocich. Overuje tedy odesilatele, ale NIJAK neposvedcuje obsah
// (kdo ten retezec jednou uvidi, umi poslat libovolny falesny "paid"). Proto tahle
// kniha slouzi jen jako VODITKO pro hledani platby - /api/refund penize nikdy nevraci
// podle ni, ale az podle platby skutecne nalezene u Stripe/PayPalu.
//
// Vyzaduje: KV "FEEDBACK" (stejny jako feedback/errlog) + env PAYHIP_API_KEY, ADMIN_TOKEN.
// Volitelne: DISCORD_WEBHOOK (okamzita notifikace o prodeji/refundu).

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.FEEDBACK;
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });

  if (!kv) return json({ ok: false, error: "KV not bound (FEEDBACK)" }, 500);

  // ---------- GET: cteni pro admin ----------
  if (request.method === "GET") {
    const token = new URL(request.url).searchParams.get("token") || "";
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ ok: false, error: "unauthorized" }, 401);
    const out = [];
    const list = await kv.list({ prefix: "sale_" });
    for (const k of list.keys) {
      const v = await kv.get(k.name);
      if (v) { try { out.push(JSON.parse(v)); } catch (e) {} }
    }
    out.sort((a, b) => (b.date || 0) - (a.date || 0));
    const refunded = out.filter(s => s.refundedAt).length;
    return json({ ok: true, count: out.length, refunded, items: out });
  }

  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  // ---------- POST: udalost od Payhipu ----------
  // Payhip posila bud JSON, nebo form-encoded - zvladneme oboji (typ neni v dokumentaci zaruceny).
  let d = null;
  const raw = await request.text();
  try { d = JSON.parse(raw); } catch (e) {
    try { d = Object.fromEntries(new URLSearchParams(raw)); } catch (e2) { d = null; }
  }
  if (!d || typeof d !== "object") return json({ ok: false, error: "bad payload" }, 400);

  // overeni odesilatele: signature == sha256(PAYHIP_API_KEY), hex, lowercase
  const apiKey = env.PAYHIP_API_KEY || "";
  if (!apiKey) return json({ ok: false, error: "endpoint not configured" }, 500);
  const expect = await sha256hex(apiKey);
  const got = (d.signature || "").toString().toLowerCase();
  if (!safeEq(got, expect)) return json({ ok: false, error: "bad signature" }, 401);

  const type = (d.type || "").toString();
  const id = (d.id || "").toString().slice(0, 80);
  if (!id) return json({ ok: true, skipped: "no id" });           // 200 = Payhip to nebude opakovat
  if (type !== "paid" && type !== "refunded") return json({ ok: true, skipped: type });

  const saleKey = "sale_" + id;
  let rec = null;
  try { rec = JSON.parse((await kv.get(saleKey)) || "null"); } catch (e) {}

  if (type === "paid") {
    rec = {
      id,
      email: (d.email || "").toString().slice(0, 200),
      price: toInt(d.price),                     // v CENTECH (Payhip: $10 = 1000)
      currency: (d.currency || "").toString().slice(0, 8).toUpperCase(),
      paymentType: (d.payment_type || "").toString().slice(0, 30),   // stripe / paypal / ...
      date: toMs(d.date) || Date.now(),
      ip: (d.ip_address || "").toString().slice(0, 45),
      items: Array.isArray(d.items) ? d.items.slice(0, 5).map(it => ({
        name: (it.product_name || it.name || "").toString().slice(0, 120),
        link: (it.product_link || it.link || "").toString().slice(0, 40),
      })) : [],
      vat: toInt(d.vat_applied),
      seen: Date.now(),
    };
    // dobrovolne pole navic (Payhip je posila jen nekdy)
    if (d.is_gift) rec.gift = true;
  } else {
    // refunded: Payhip uz sam vypnul licencni klic (viz jeho dokumentace), my si to jen zapisem
    rec = rec || { id, email: (d.email || "").toString().slice(0, 200), price: toInt(d.price), currency: (d.currency || "").toString().toUpperCase(), date: toMs(d.date_created) || toMs(d.date) || 0 };
    rec.refundedAt = toMs(d.date_refunded) || Date.now();
    rec.refundedCents = toInt(d.amount_refunded);
    rec.refundFull = rec.price > 0 && rec.refundedCents >= rec.price;
    rec.refundVia = rec.refundVia || "payhip";   // /api/refund si sem pise "stripe"/"paypal"
  }

  await kv.put(saleKey, JSON.stringify(rec));    // bez TTL: ucetni kniha se nemaze sama

  // INDEX PODLE E-MAILU: /api/refund musi najit nakup podle e-mailu, ale NESMI kvuli tomu
  // scanovat celou knihu - Cloudflare ma limit poctu subrequestu na jeden pozadavek a kazde
  // KV cteni se pocita. Index drzi max 20 poslednich nakupu daneho e-mailu.
  try {
    if (rec.email) {
      const ik = "idx_" + (await sha256hex(rec.email.trim().toLowerCase())).slice(0, 24);
      let ids = [];
      try { ids = JSON.parse((await kv.get(ik)) || "[]"); } catch (e) {}
      if (!Array.isArray(ids)) ids = [];
      if (!ids.includes(id)) { ids.push(id); await kv.put(ik, JSON.stringify(ids.slice(-20))); }
    }
  } catch (e) {}

  // notifikace majiteli (nepovinna - kdyz webhook Discordu selze, udalost se tim NESMI ztratit)
  try {
    if (env.DISCORD_WEBHOOK) {
      const money = (rec.price / 100).toFixed(2) + " " + (rec.currency || "");
      const msg = type === "paid"
        ? "**Prodej** " + money + " — " + mask(rec.email) + (rec.paymentType ? " (" + rec.paymentType + ")" : "")
        : "**REFUND** " + ((rec.refundedCents || 0) / 100).toFixed(2) + " " + (rec.currency || "") + " — " + mask(rec.email) + " (" + (rec.refundVia || "payhip") + ")";
      await fetch(env.DISCORD_WEBHOOK, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: msg.slice(0, 1900) }),
      });
    }
  } catch (e) {}

  return json({ ok: true, type, id });
}

// ---------- pomocne ----------
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
// porovnani v konstantnim case (delka se stejne lisit nesmi - oba jsou hex sha256)
function safeEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
// Payhip posila datum bud jako epochu (s nebo ms), nebo jako "2026-09-14 10:00:00"
function toMs(v) {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = parseInt(v, 10);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(String(v).replace(" ", "T") + (/[zZ+]|\d{2}:\d{2}$/.test(String(v)) ? "" : "Z"));
  return Number.isFinite(t) ? t : 0;
}
function mask(email) {
  const s = (email || "").toString();
  const at = s.indexOf("@");
  if (at < 1) return s || "?";
  return s.slice(0, Math.min(3, at)) + "***" + s.slice(at);
}
