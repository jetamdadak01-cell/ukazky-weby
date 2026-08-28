// Cloudflare Pages Function — feedback z aplikace PitWise
//   POST   /api/feedback                          -> ulozi feedback do KV (per-IP limit 6/den)
//   GET    /api/feedback?token=XXX                -> vrati vsechen feedback (jen s admin tokenem)
//   DELETE /api/feedback?token=XXX&keys=a,b,c     -> smaze polozky podle klicu (max 100, jen admin)
// Vyzaduje: KV namespace navazany jako "FEEDBACK" + promenna prostredi "ADMIN_TOKEN".

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.FEEDBACK;
  const admin = env.ADMIN_TOKEN || "";
  // ZADNY CORS: appka posila z PowerShellu (mimo prohlizec) a admin je same-origin (/admin).
  // Drivejsi "Access-Control-Allow-Origin: *" zbytecne otviral admin GET (e-maily zakazniku)
  // cizim webum - odstranen na doporuceni security auditu.
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });

  if (!kv) return json({ ok: false, error: "KV not bound (FEEDBACK)" }, 500);

  if (request.method === "POST") {
    // RATE LIMIT per IP (2026-08: nekdo poslal ~35x spam + blind-XSS payloady behem par minut).
    // KV je eventualne konzistentni = limit je hruby, ale flood zastavi. Legit uzivatel z appky
    // posle 1-2 zpravy; 6/den je bezpecna rezerva.
    const ip = request.headers.get("cf-connecting-ip") || "0";
    const rlKey = "rl_" + ip;
    let rlCnt = 0;
    try { rlCnt = parseInt((await kv.get(rlKey)) || "0", 10) || 0; } catch (e) {}
    if (rlCnt >= 6) return json({ ok: false, error: "rate limit" }, 429);
    let data = {};
    try { data = await request.json(); } catch (e) {}
    const msg = (data.message || "").toString().slice(0, 4000).trim();
    if (!msg) return json({ ok: false, error: "empty" }, 400);
    // utocne payloady NEzahazujeme (chceme utoky videt), jen oznacime - admin je zobrazi
    // s varovanim a umi je smazat jednim tlacitkem. Escapovani na strane adminu drzi.
    const sus = /<script|<\/script|onerror\s*=|onload\s*=|javascript:|<img\b|<svg\b|srcdoc|document\.cookie|localStorage/i.test(msg);
    const item = {
      message: msg,
      email: (data.email || "").toString().slice(0, 200),
      app: (data.app || "PitWise").toString().slice(0, 40),
      ver: (data.ver || "").toString().slice(0, 20),
      ts: Date.now(),
      country: request.headers.get("cf-ipcountry") || "",
    };
    if (sus) item.sus = true;
    const key = "fb_" + item.ts + "_" + Math.random().toString(36).slice(2, 8);
    await kv.put(key, JSON.stringify(item));
    try { await kv.put(rlKey, String(rlCnt + 1), { expirationTtl: 60 * 60 * 24 }); } catch (e) {}
    return json({ ok: true });
  }

  if (request.method === "GET") {
    const token = new URL(request.url).searchParams.get("token") || "";
    if (!admin || token !== admin) return json({ ok: false, error: "unauthorized" }, 401);
    const list = await kv.list({ prefix: "fb_" });
    const items = [];
    for (const k of list.keys) {
      const v = await kv.get(k.name);
      if (v) { try { const o = JSON.parse(v); o._key = k.name; items.push(o); } catch (e) {} }
    }
    items.sort((a, b) => b.ts - a.ts);
    return json({ ok: true, count: items.length, items });
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    if (!admin || token !== admin) return json({ ok: false, error: "unauthorized" }, 401);
    const keys = (url.searchParams.get("keys") || "").split(",").map(s => s.trim()).filter(k => k.startsWith("fb_")).slice(0, 100);
    if (!keys.length) return json({ ok: false, error: "no keys" }, 400);
    let deleted = 0;
    for (const k of keys) { try { await kv.delete(k); deleted++; } catch (e) {} }
    return json({ ok: true, deleted });
  }

  return json({ ok: false, error: "method" }, 405);
}
