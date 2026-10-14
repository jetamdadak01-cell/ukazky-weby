// Cloudflare Pages Function — sber chyb z aplikace PitWise (vzdalena diagnostika)
//   POST /api/errlog             -> ulozi davku chyb do KV (prefix err_, TTL 30 dni)
//   GET  /api/errlog?token=XXX   -> davky NEJNOVEJSI PRVNI, po strankach (jen s admin tokenem)
//        &limit=N     davek na stranku (vychozi 500, max 900)
//        &aid=XXX     jen davky jednoho uzivatele (cele anon id nebo jeho zacatek)
//        &since=MS    jen davky s ts >= MS (unix ms)
//        &cursor=XXX  dalsi stranka: hodnota "cursor" z predchozi odpovedi
//      odpoved { ok, count, items, cursor, list_complete, total } - list_complete=false => existuje dalsi stranka
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
    // metadata (aid, ver) vraci uz kv.list -> GET s &aid= nemusi cist cizi davky
    await kv.put(key, JSON.stringify(batch), { expirationTtl: 60 * 60 * 24 * 30, metadata: { aid: batch.aid, ver: batch.ver } });
    if (dk) { try { await kv.put(dk, "1", { expirationTtl: 60 * 60 * 24 * 30 }); } catch (e) {} }
    return json({ ok: true });
  }

  if (request.method === "GET") {
    const q = new URL(request.url).searchParams;
    const token = q.get("token") || "";
    if (!admin || token !== admin) return json({ ok: false, error: "unauthorized" }, 401);
    // STRANKOVANI (14.10.2026): drive kv.list bez kurzoru = max 1000 klicu ABECEDNE = tech NEJSTARSICH + 1 get na klic.
    // Nad 1000 davek by zmizely prave nejnovejsi a GET by narazil na limit ~1000 KV operaci na volani.
    // Ted: vypis vsech klicu (1 operace na 1000 klicu), serazeni od nejnovejsiho, get jen pro jednu stranku.
    // Cas je v nazvu klice (err_<ts>_<rnd>) -> since bez cteni; aid z metadat (davky pred 14.10. je nemaji -> get).
    const limit = Math.min(900, Math.max(1, parseInt(q.get("limit") || "", 10) || 500));
    const aid = (q.get("aid") || "").slice(0, 40);
    const since = parseInt(q.get("since") || "", 10) || 0;
    const cursor = q.get("cursor") || "";
    if (cursor && !/^err_\d+_[A-Za-z0-9]*$/.test(cursor)) return json({ ok: false, error: "bad cursor" }, 400);
    const keys = [];
    let ops = 0, lc = "";
    do {
      const r = await kv.list(lc ? { prefix: "err_", cursor: lc } : { prefix: "err_" });
      ops++;
      keys.push(...r.keys);
      lc = r.list_complete ? "" : r.cursor;
    } while (lc && ops < 50);
    keys.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    // cursor = posledni zpracovany klic predchozi stranky -> pokracuje se klici starsimi nez on
    let pos = cursor ? keys.findIndex(k => k.name < cursor) : 0;
    if (pos < 0) pos = keys.length;
    let budget = 950 - ops, hitSince = false;
    const items = [];
    while (pos < keys.length && items.length < limit && budget > 0 && !hitSince) {
      const want = Math.min(25, budget, limit - items.length), names = [];
      while (pos < keys.length && names.length < want) {
        const k = keys[pos];
        if (since && keyTs(k.name) < since) { hitSince = true; break; }
        pos++;
        const ma = k.metadata && typeof k.metadata.aid === "string" ? k.metadata.aid : null;
        if (aid && ma !== null && !ma.startsWith(aid)) continue;
        names.push(k.name);
      }
      if (!names.length) continue;
      const vals = await Promise.all(names.map(n => kv.get(n)));
      budget -= names.length;
      vals.forEach((v, j) => {
        if (!v) return;
        try {
          const o = JSON.parse(v);
          if (aid && !String(o.aid || "").startsWith(aid)) return;
          o._key = names[j]; items.push(o);
        } catch (e) {}
      });
    }
    // poradi items = poradi klicu (nejnovejsi prvni), proto uz se neradi podle ts
    const done = hitSince || pos >= keys.length;
    const next = done ? null : pos > 0 ? keys[pos - 1].name : cursor || null;
    return json({ ok: true, count: items.length, items, cursor: next, list_complete: done, total: keys.length });
  }

  return json({ ok: false, error: "method" }, 405);
}

// err_<ts>_<rnd> -> ts (ms). Stejne jako ve watchdog.js.
function keyTs(name) { return parseInt((name.split("_")[1] || "0"), 10) || 0; }

// SHA-256 -> hex. Pouziva se jen na rate-limit klice, aby se do KV nikdy neulozila IP.
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
