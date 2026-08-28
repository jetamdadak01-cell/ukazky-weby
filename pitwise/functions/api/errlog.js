// Cloudflare Pages Function — sber chyb z aplikace PitWise (vzdalena diagnostika)
//   POST /api/errlog             -> ulozi davku chyb do KV (prefix err_, TTL 30 dni)
//   GET  /api/errlog?token=XXX   -> vrati vsechny chyby (jen s admin tokenem)
// Pouziva STEJNY KV namespace jako feedback ("FEEDBACK") - zadna dalsi konfigurace v CF.
// Data jsou anonymni: verze, anonymni id (hash), zeme, chybove radky (bez e-mailu).

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.FEEDBACK;
  const admin = env.ADMIN_TOKEN || "";
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });

  if (!kv) return json({ ok: false, error: "KV not bound (FEEDBACK)" }, 500);

  if (request.method === "POST") {
    // stejny hruby per-IP limit jako feedback (errlog davky: appka posila max par za beh)
    const ip = request.headers.get("cf-connecting-ip") || "0";
    const rlKey = "rle_" + ip;
    let rlCnt = 0;
    try { rlCnt = parseInt((await kv.get(rlKey)) || "0", 10) || 0; } catch (e) {}
    if (rlCnt >= 40) return json({ ok: false, error: "rate limit" }, 429);
    let data = {};
    try { data = await request.json(); } catch (e) {}
    const items = Array.isArray(data.items) ? data.items.slice(0, 25) : [];
    if (!items.length) return json({ ok: false, error: "empty" }, 400);
    try { await kv.put(rlKey, String(rlCnt + 1), { expirationTtl: 60 * 60 * 24 }); } catch (e) {}
    const batch = {
      ver: (data.ver || "").toString().slice(0, 20),
      aid: (data.aid || "").toString().slice(0, 40),
      ts: Date.now(),
      country: request.headers.get("cf-ipcountry") || "",
      items: items.map(i => ({
        at: (i.at || "").toString().slice(0, 30),
        src: (i.src || "").toString().slice(0, 30),
        msg: (i.msg || "").toString().slice(0, 600),
      })),
    };
    const key = "err_" + batch.ts + "_" + Math.random().toString(36).slice(2, 8);
    await kv.put(key, JSON.stringify(batch), { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ ok: true });
  }

  if (request.method === "GET") {
    const token = new URL(request.url).searchParams.get("token") || "";
    if (!admin || token !== admin) return json({ ok: false, error: "unauthorized" }, 401);
    const list = await kv.list({ prefix: "err_" });
    const items = [];
    for (const k of list.keys) {
      const v = await kv.get(k.name);
      if (v) { try { const o = JSON.parse(v); o._key = k.name; items.push(o); } catch (e) {} }
    }
    items.sort((a, b) => b.ts - a.ts);
    return json({ ok: true, count: items.length, items });
  }

  return json({ ok: false, error: "method" }, 405);
}
