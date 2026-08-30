// Cloudflare Pages Function — KOMUNITNI SETUPY (PitWise, zatim jen ACC - jedina hra
// s citelnymi/zapisovatelnymi setup JSONy). Hrac nasdili setup -> tabulka; ostatni
// si ho stahnou a appka ho zapise do ACC slozky Setups.
//   POST   /api/setup                              -> ulozi setup (limit 5/den/IP, max 15 na trat+auto)
//   GET    /api/setup?sim=acc&track=X&car=Y        -> seznam metadat (bez tela setupu)
//   GET    /api/setup?key=su_...                   -> jeden kompletni setup
//   DELETE /api/setup?token=ADMIN&keys=a,b         -> moderace (jen admin)
// Pouziva stejny KV namespace "FEEDBACK" (zadna dalsi konfigurace v CF).

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.FEEDBACK;
  const admin = env.ADMIN_TOKEN || "";
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
  if (!kv) return json({ ok: false, error: "KV not bound (FEEDBACK)" }, 500);

  // slug pro klic: sim|track|car -> bezpecny prefix (kolize po orezani jsou ok, filtrujeme i podle hodnot)
  const slug = (s) => (s || "").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

  if (request.method === "POST") {
    const ip = request.headers.get("cf-connecting-ip") || "0";
    const rlKey = "rls_" + ip;
    let rlCnt = 0;
    try { rlCnt = parseInt((await kv.get(rlKey)) || "0", 10) || 0; } catch (e) {}
    if (rlCnt >= 5) return json({ ok: false, error: "rate limit" }, 429);
    let data = {};
    try { data = await request.json(); } catch (e) {}
    const sim = (data.sim || "").toString().slice(0, 12);
    const track = (data.track || "").toString().slice(0, 60).trim();
    const car = (data.car || "").toString().slice(0, 60).trim();
    const name = ((data.name || "").toString().slice(0, 24).trim()) || "anonym";
    const lapMs = parseInt(data.lapMs, 10) || 0;
    if (sim !== "acc") return json({ ok: false, error: "only acc setups for now" }, 400);
    if (!track || !car) return json({ ok: false, error: "track/car missing" }, 400);
    if (!data.setup || typeof data.setup !== "object") return json({ ok: false, error: "setup missing" }, 400);
    const setupStr = JSON.stringify(data.setup);
    if (setupStr.length > 30000) return json({ ok: false, error: "setup too big" }, 400);
    if (!data.setup.basicSetup) return json({ ok: false, error: "not an ACC setup json" }, 400);
    const prefix = "su_" + slug(sim + "|" + track + "|" + car) + "_";
    const item = {
      sim, track, car, name,
      lapMs: (lapMs >= 20000 && lapMs <= 900000) ? lapMs : 0,
      ts: Date.now(),
      country: request.headers.get("cf-ipcountry") || "",
      setup: data.setup,
    };
    const key = prefix + item.ts + "_" + Math.random().toString(36).slice(2, 8);
    await kv.put(key, JSON.stringify(item));
    try { await kv.put(rlKey, String(rlCnt + 1), { expirationTtl: 60 * 60 * 24 }); } catch (e) {}
    // CAP: max 15 setupu na trat+auto - nejstarsi se mazou (klice zacinaji timestampem = radi se samy)
    try {
      const list = await kv.list({ prefix });
      if (list.keys.length > 15) {
        const sorted = list.keys.map(k => k.name).sort();   // ts v nazvu -> vzestupne = nejstarsi prvni
        for (const old of sorted.slice(0, sorted.length - 15)) { await kv.delete(old); }
      }
    } catch (e) {}
    return json({ ok: true, key });
  }

  if (request.method === "GET") {
    const url = new URL(request.url);
    const oneKey = url.searchParams.get("key") || "";
    if (oneKey) {
      if (!oneKey.startsWith("su_")) return json({ ok: false, error: "bad key" }, 400);
      const v = await kv.get(oneKey);
      if (!v) return json({ ok: false, error: "not found" }, 404);
      try { const o = JSON.parse(v); o._key = oneKey; return json({ ok: true, item: o }); } catch (e) { return json({ ok: false, error: "corrupt" }, 500); }
    }
    const sim = url.searchParams.get("sim") || "";
    const track = url.searchParams.get("track") || "";
    const car = url.searchParams.get("car") || "";
    if (!sim || !track || !car) return json({ ok: false, error: "sim/track/car required" }, 400);
    const prefix = "su_" + slug(sim + "|" + track + "|" + car) + "_";
    const list = await kv.list({ prefix });
    const items = [];
    for (const k of list.keys) {
      const v = await kv.get(k.name);
      if (!v) continue;
      try {
        const o = JSON.parse(v);
        // metadata bez tela setupu (setup se stahuje az pri instalaci - setri prenos)
        items.push({ key: k.name, name: o.name, lapMs: o.lapMs, ts: o.ts, country: o.country });
      } catch (e) {}
    }
    // nejrychlejsi nahore (bez casu nakonec), pak nejnovejsi
    items.sort((a, b) => ((a.lapMs || 9999999) - (b.lapMs || 9999999)) || (b.ts - a.ts));
    return json({ ok: true, count: items.length, items });
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    if (!admin || token !== admin) return json({ ok: false, error: "unauthorized" }, 401);
    const keys = (url.searchParams.get("keys") || "").split(",").map(s => s.trim()).filter(k => k.startsWith("su_")).slice(0, 100);
    if (!keys.length) return json({ ok: false, error: "no keys" }, 400);
    let deleted = 0;
    for (const k of keys) { try { await kv.delete(k); deleted++; } catch (e) {} }
    return json({ ok: true, deleted });
  }

  return json({ ok: false, error: "method" }, 405);
}
