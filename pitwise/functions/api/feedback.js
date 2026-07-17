// Cloudflare Pages Function — feedback z aplikace PitWise
//   POST /api/feedback            -> ulozi feedback do KV
//   GET  /api/feedback?token=XXX  -> vrati vsechen feedback (jen s admin tokenem)
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
    let data = {};
    try { data = await request.json(); } catch (e) {}
    const msg = (data.message || "").toString().slice(0, 4000).trim();
    if (!msg) return json({ ok: false, error: "empty" }, 400);
    const item = {
      message: msg,
      email: (data.email || "").toString().slice(0, 200),
      app: (data.app || "PitWise").toString().slice(0, 40),
      ver: (data.ver || "").toString().slice(0, 20),
      ts: Date.now(),
      country: request.headers.get("cf-ipcountry") || "",
    };
    const key = "fb_" + item.ts + "_" + Math.random().toString(36).slice(2, 8);
    await kv.put(key, JSON.stringify(item));
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

  return json({ ok: false, error: "method" }, 405);
}
