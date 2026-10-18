// Cloudflare Pages Function — licencovane auto-aktualizace PitWise
//   GET /api/update?file=ps1|exe&key=LICENCNI-KLIC
//   1) overi licencni klic u Payhipu (jen platici zakaznici)
//   2) kdyz je platny, vrati soubor z PRIVATNIHO GitHub repa
// Vyzaduje env promenne (Cloudflare Pages > Settings > Environment variables):
//   PAYHIP_PRODUCT_SECRET - product secret key produktu (prod_sk_...) -> overeni pres Payhip API v2 (preferovane)
//   PAYHIP_API_KEY  - Payhip Settings > Developer > API key -> overeni pres API v1 (zaloha / bez v2)
//                     (staci jedna z techto dvou; obe = v2 a pri odmitnuti naseho secretu zaloha v1)
//   PAYHIP_PRODUCT  - product link produktu (mquCD), volitelne
//   GH_TOKEN        - GitHub fine-grained token (read-only Contents na private repo)
//   GH_REPO         - "jetamdadak01-cell/pitwise-files-private"
//   FEEDBACK (KV)   - volitelne: pri problemu s NASIMI Payhip klici zapise davku do errlogu (src srv-update-*)
//   DISCORD_WEBHOOK - volitelne: k te davce hned i zprava do Discordu

export async function onRequest(context) {
  const { request, env } = context;
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  if (request.method !== "GET") return json({ ok: false, error: "method" }, 405);

  const url = new URL(request.url);
  const names = { ps1: "PitWise.ps1", exe: "PitWise.exe" };
  const file = url.searchParams.get("file") || "";
  const key = (url.searchParams.get("key") || "").trim();

  if (!names[file]) return json({ ok: false, error: "bad file param (ps1|exe)" }, 400);
  if (!key) return json({ ok: false, error: "license key required" }, 403);
  const hasV2 = !!env.PAYHIP_PRODUCT_SECRET, hasV1 = !!env.PAYHIP_API_KEY;
  if ((!hasV1 && !hasV2) || !env.GH_TOKEN || !env.GH_REPO) return json({ ok: false, error: "endpoint not configured" }, 500);
  // licencni klic ma ~25 znaku; obri retezec by jen delal 414 u Payhipu (= falesny poplach "nase klice")
  if (key.length > 200) return json({ ok: false, error: "invalid license key" }, 403);

  // 1) overeni licencniho klice u Payhipu. Vysledek pokusu: valid / invalid / down / auth
  //    invalid = Payhip klic opravdu odmitl -> 403 (klient hlasi "neplatny licencni klic")
  //    down    = Payhip nedostupny (5xx, 429, sit, rozbita/necekana odpoved) -> 503 (FR 11.10.2026)
  //    auth    = Payhip odmitl NASE klice (401/403) nebo jine necekane 4xx -> 503, NIKDY 403 zakaznikovi.
  //              (17.-18.10.2026: nekdo pregeneroval Payhip API key, v1 vracel 401 a vsichni platici
  //              zakaznici 2 dny videli "invalid license key".) + zapis do errlogu, max 1x za hodinu.
  //    v2 (product secret) nezavisi na API klici uctu -> preferovane; v1 jako zaloha (v2 odmitne secret / nejde)
  //    a jako kontrola, kdyz v2 rekne "neznamy klic" (secret k jinemu produktu by jinak dal 403 vsem).
  //    Klic z e-mailu casto prijde s mezerou / neviditelnym znakem uprostred nebo malymi pismeny -> 2. pokus normalizovany.
  const product = env.PAYHIP_PRODUCT || "mquCD";
  const authFails = [];                                   // napr. "v2 401" - jen verze API a status, nikdy klic
  let mismatch = false;                                   // v2 klic odmitl, v1 ho uznal = spatne nastaveny secret
  const ask = async (u, headers) => {
    try {
      const v = await fetch(u, { headers });
      if (!v.ok) return { s: v.status };
      const t = await v.text();
      let j = null;
      try { j = JSON.parse(t); } catch (e) {}
      return { s: v.status, ok: true, j: j && typeof j === "object" ? j : null };
    } catch (e) {
      return { s: 0 };
    }
  };
  // spolecne trideni odpovedi; badReq = statusy, ktere u dane verze API znamenaji "klic neexistuje"
  const classify = (r, api, badReq) => {
    if (r.s === 0) return "down";
    if (r.ok) {
      if (!r.j) return "down";                            // 200, ale neprectitelne telo
      const d = r.j.data;
      if (Array.isArray(d)) return d.length === 0 ? "invalid" : "down";   // v1: neznamy klic = data:[]
      if (!d || typeof d !== "object") return "down";                    // necekany tvar -> nevinit zakaznika
      if (d.enabled !== true) return "invalid";                          // vypnuty (refund) klic
      if (api === "v2" && d.product_link && d.product_link !== product) return "invalid";   // v2 neni omezene product_linkem v dotazu
      return "valid";
    }
    if (badReq.includes(r.s)) return "invalid";
    if (r.s >= 500 || r.s === 429) return "down";
    authFails.push(api + " " + r.s);                      // 401/403 i cokoli necekaneho = chyba na nasi strane
    return "auth";
  };
  const v1 = async (k) => classify(await ask(
    "https://payhip.com/api/v1/license/verify?product_link=" + encodeURIComponent(product) + "&license_key=" + encodeURIComponent(k),
    { "payhip-api-key": env.PAYHIP_API_KEY }), "v1", []);
  const v2 = async (k) => classify(await ask(
    "https://payhip.com/api/v2/license/verify?license_key=" + encodeURIComponent(k),
    { "product-secret-key": env.PAYHIP_PRODUCT_SECRET }), "v2", [400, 404]);
  const verify = async (k) => {
    if (!hasV2) return v1(k);
    const r = await v2(k);
    if (r === "valid" || !hasV1) return r;
    if (r === "auth" || r === "down") return v1(k);       // nas secret odmitnut / v2 nejde -> zaloha pres API klic uctu
    const r1 = await v1(k);                               // v2 "neznamy klic" -> over pres v1 (v1 je omezene product_linkem)
    if (r1 === "valid") { mismatch = true; return "valid"; }
    return "invalid";                                     // v1 nefunguje / taky neuznal -> drz se v2
  };
  let res = await verify(key);
  const norm = key.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "").toUpperCase();
  if (res !== "valid" && norm && norm !== key) {
    const r2 = await verify(norm);
    // normalizovany klic je smerodatny; raw "invalid" jen rika, ze surovy retezec neni klic
    if (r2 === "valid" || r2 === "invalid" || res === "invalid") res = r2;
  }
  // zapis do errlogu (+ Discord) na pozadi - nikdy nezdrzi ani neshodi odpoved
  const later = (p) => { p = p.catch(() => {}); try { if (typeof context.waitUntil === "function") context.waitUntil(p); } catch (e) {} };
  const fails = [...new Set(authFails)].join(" / ");
  if (res === "auth") {
    later(logSrv(env, "srvflag_update_auth", "srv-update-auth",
      "Payhip " + (fails || "?") + ": our API credentials were rejected - customers cannot update (check PAYHIP_API_KEY / PAYHIP_PRODUCT_SECRET in Cloudflare)"));
    return json({ ok: false, error: "license check temporarily unavailable on our side, try again later" }, 503);
  }
  if (fails) later(logSrv(env, "srvflag_update_degraded", "srv-update-degraded",
    "Payhip " + fails + ": one of our API credentials was rejected, updates now depend on the other one (check PAYHIP_API_KEY / PAYHIP_PRODUCT_SECRET in Cloudflare)"));
  if (mismatch) later(logSrv(env, "srvflag_update_mismatch", "srv-update-mismatch",
    "Payhip v2 rejected a key that v1 accepts - PAYHIP_PRODUCT_SECRET is probably for another product (or PAYHIP_PRODUCT is wrong)"));
  if (res === "down") return json({ ok: false, error: "license server unavailable, try again later" }, 503);
  if (res !== "valid") return json({ ok: false, error: "invalid license key" }, 403);

  // 2) soubor z privatniho repa (Contents API s raw media typem)
  //    channel=beta -> soubory z beta/ slozky (beta testeri s klicem v aplikaci)
  const channel = url.searchParams.get("channel") === "beta" ? "beta/" : "";
  const gh = await fetch(
    "https://api.github.com/repos/" + env.GH_REPO + "/contents/" + channel + names[file] + "?ref=main",
    { headers: { "Authorization": "Bearer " + env.GH_TOKEN, "Accept": "application/vnd.github.raw", "User-Agent": "pitwise-update-endpoint" } }
  );
  if (!gh.ok) return json({ ok: false, error: "file fetch failed " + gh.status }, 502);

  return new Response(gh.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="' + names[file] + '"',
      "Cache-Control": "no-store",
    },
  });
}

// Problem s NASIMI Payhip klici -> 1 davka do errlogu (stejny format jako /api/errlog) + Discord, max 1x za hodinu na druh.
// Throttle je best-effort: flag v KV se zapisuje PRED davkou (kdyz zapis flagu selze, davka se nepise),
// soubezne pozadavky v jednom isolatu hlida "inflight". Nikdy nevyhodi vyjimku;
// do zpravy jde jen verze API + status (zadny klic zakaznika, API key ani secret).
const inflight = new Set();
async function logSrv(env, flag, src, msg) {
  const kv = env.FEEDBACK;
  if (!kv || inflight.has(flag)) return;
  inflight.add(flag);
  try {
    if (await kv.get(flag)) return;
    try { await kv.put(flag, "1", { expirationTtl: 3600 }); } catch (e) { return; }
    const ts = Date.now();
    const batch = {
      ver: "server", aid: "server-update", ts, country: "--", bid: "",
      items: [{ at: new Date(ts).toISOString(), src, msg: String(msg).slice(0, 600) }],
    };
    const k = "err_" + ts + "_" + Math.random().toString(36).slice(2, 8);
    await kv.put(k, JSON.stringify(batch), { expirationTtl: 60 * 60 * 24 * 30, metadata: { aid: batch.aid, ver: batch.ver } });
    // okamzite upozorneni - denni hlidac by to hlasil az druhy den
    if (env.DISCORD_WEBHOOK) {
      try {
        await fetch(env.DISCORD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "**PitWise /api/update (" + src + "): " + batch.items[0].msg + "**" }) });
      } catch (e) {}
    }
  } catch (e) {
  } finally {
    inflight.delete(flag);
  }
}
