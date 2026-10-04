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
    // stejna minimalizace jako u feedbacku: v KV je hash, ne IP
    const ip = request.headers.get("cf-connecting-ip") || "0";
    const rlKey = "rle_" + (await sha256hex("pitwise-rl:" + ip)).slice(0, 24);
    let rlCnt = 0;
    try { rlCnt = parseInt((await kv.get(rlKey)) || "0", 10) || 0; } catch (e) {}
    if (rlCnt >= 40) return json({ ok: false, error: "rate limit" }, 429);
    let data = {};
    try { data = await request.json(); } catch (e) {}
    const items = Array.isArray(data.items) ? data.items.slice(0, 25) : [];
    if (!items.length) return json({ ok: false, error: "empty" }, 400);
    // DEDUP DAVKY (3.10.2026): appka po zabitem/spadlem procesu posle tutez davku znovu se STEJNYM bid -> podruhe neukladat
    // (drive: AT 2.29.91 / DE 2.29.0 / NL 2.28.5 - tataz davka 2x). Bez bid (stare verze) = beze zmeny.
    const bid = (data.bid || "").toString().replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
    const dk = bid ? "errb_" + (await sha256hex((data.aid || "").toString().slice(0, 40) + "|" + bid)).slice(0, 32) : "";
    if (dk) { try { if (await kv.get(dk)) return json({ ok: true, dup: true }); } catch (e) {} }
    try { await kv.put(rlKey, String(rlCnt + 1), { expirationTtl: 60 * 60 * 24 }); } catch (e) {}
    const batch = {
      ver: (data.ver || "").toString().slice(0, 20),
      aid: (data.aid || "").toString().slice(0, 40),
      ts: Date.now(),
      country: request.headers.get("cf-ipcountry") || "",
      bid,
      items: items.map(i => ({
        at: (i.at || "").toString().slice(0, 30),
        src: (i.src || "").toString().slice(0, 30),
        msg: (i.msg || "").toString().slice(0, 600),
      })),
    };
    const key = "err_" + batch.ts + "_" + Math.random().toString(36).slice(2, 8);
    await kv.put(key, JSON.stringify(batch), { expirationTtl: 60 * 60 * 24 * 30 });
    if (dk) { try { await kv.put(dk, "1", { expirationTtl: 60 * 60 * 24 * 30 }); } catch (e) {} }
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

// SHA-256 -> hex. Pouziva se jen na rate-limit klice, aby se do KV nikdy neulozila IP.
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
