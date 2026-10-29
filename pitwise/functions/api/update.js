// Cloudflare Pages Function — licencovane auto-aktualizace PitWise
//   GET /api/update?file=ps1|exe|check&key=LICENCNI-KLIC
//   file=check = jen overeni klice (licencni brana v aplikaci): 200 {ok:true} / 403 / 503, GitHub nepotrebuje
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
//   ADMIN_TOKEN     - jen pro diagnostiku: GET /api/update?diag=1&token=... (tvar nasich Payhip klicu + zivy test, bez hodnot)

export async function onRequest(context) {
  const { request, env } = context;
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  if (request.method !== "GET") return json({ ok: false, error: "method" }, 405);

  const url = new URL(request.url);
  // Hodnoty vlozene do Cloudflare dashboardu: obcas s uvozovkami / mezerou / zalomenim / neviditelnym znakem z kopirovani.
  // Payhip by je odmitl 401 (= "nase klice") a zalomeni uprostred by shodilo fetch (= falesne "down"). Payhip klice mezery nemaji.
  const API_KEY = cleanCred(env.PAYHIP_API_KEY), SECRET = cleanCred(env.PAYHIP_PRODUCT_SECRET);
  const product = env.PAYHIP_PRODUCT || "mquCD";
  if (url.searchParams.get("diag") === "1") return diag(env, url, json, API_KEY, SECRET, product);

  const names = { ps1: "PitWise.ps1", exe: "PitWise.exe" };
  const file = url.searchParams.get("file") || "";
  const key = (url.searchParams.get("key") || "").trim();

  const check = file === "check";
  if (!check && !names[file]) return json({ ok: false, error: "bad file param (ps1|exe)" }, 400);
  if (!key) return json({ ok: false, error: "license key required" }, 403);
  const rawSet = !!(env.PAYHIP_API_KEY || env.PAYHIP_PRODUCT_SECRET);
  if (!rawSet || (!check && (!env.GH_TOKEN || !env.GH_REPO))) return json({ ok: false, error: "endpoint not configured" }, 500);
  // licencni klic ma ~25 znaku; obri retezec by jen delal 414 u Payhipu (= falesny poplach "nase klice")
  if (key.length > 200) return json({ ok: false, error: "invalid license key" }, 403);
  // per-IP limit pro file=check (zkouseni klicu nesmi vycerpat Payhip limit), stejny vzor jako errlog.js; bez KV FEEDBACK limit neni
  if (check && env.FEEDBACK) {
    const kv = env.FEEDBACK;
    const rlKey = "rlc_" + (await sha256hex("pitwise-rl:" + (request.headers.get("cf-connecting-ip") || "0"))).slice(0, 24);
    let rlCnt = 0;
    try { rlCnt = parseInt((await kv.get(rlKey)) || "0", 10) || 0; } catch (e) {}
    if (rlCnt >= 20) return json({ ok: false, error: "too many attempts, try again later" }, 429);
    try { await kv.put(rlKey, String(rlCnt + 1), { expirationTtl: 60 * 60 }); } catch (e) {}
  }
  // zapis do errlogu (+ Discord) na pozadi - nikdy nezdrzi ani neshodi odpoved
  const later = (p) => { p = p.catch(() => {}); try { if (typeof context.waitUntil === "function") context.waitUntil(p); } catch (e) {} };
  const AUTH503 = () => json({ ok: false, error: "license check temporarily unavailable on our side, try again later" }, 503);
  if (!API_KEY && !SECRET) {                              // nastavene, ale po orezani prazdne (jen uvozovky / mezery)
    later(logSrv(env, "srvflag_update_auth", "srv-update-auth",
      "PAYHIP_API_KEY / PAYHIP_PRODUCT_SECRET are set but empty after removing quotes/spaces - customers cannot update (re-paste them in Cloudflare)"));
    return AUTH503();
  }

  // 1) overeni licencniho klice u Payhipu. Vysledek pokusu: valid / invalid / down / auth
  //    invalid = Payhip klic opravdu odmitl -> 403 (klient hlasi "neplatny licencni klic")
  //    down    = Payhip nedostupny (5xx, 429, sit, rozbita/necekana odpoved) -> 503 (FR 11.10.2026)
  //    auth    = Payhip odmitl NASE klice (401/403) nebo jine necekane 4xx -> 503, NIKDY 403 zakaznikovi.
  //              (17.-18.10.2026: nekdo pregeneroval Payhip API key, v1 vracel 401 a vsichni platici
  //              zakaznici 2 dny videli "invalid license key".) + zapis do errlogu, max 1x za hodinu.
  //    v2 (product secret) nezavisi na API klici uctu -> preferovane; v1 jako zaloha (v2 odmitne secret / nejde)
  //    a jako kontrola, kdyz v2 rekne "neznamy klic" (secret k jinemu produktu by jinak dal 403 vsem).
  //    Klic z e-mailu casto prijde s mezerou / neviditelnym znakem uprostred nebo malymi pismeny -> 2. pokus normalizovany.
  const authFails = [];                                   // napr. "v2 401" - jen verze API a status, nikdy klic
  let mismatch = false;                                   // v2 klic odmitl, v1 ho uznal = spatne nastaveny secret
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
  // apiKey = hodnota pro v1 (hlavicka payhip-api-key), secret = hodnota pro v2 (hlavicka product-secret-key)
  const v1 = async (k, apiKey) => classify(await askPayhip(
    "https://payhip.com/api/v1/license/verify?product_link=" + encodeURIComponent(product) + "&license_key=" + encodeURIComponent(k),
    { "payhip-api-key": apiKey }), "v1", []);
  const v2 = async (k, secret) => classify(await askPayhip(
    "https://payhip.com/api/v2/license/verify?license_key=" + encodeURIComponent(k),
    { "product-secret-key": secret }), "v2", [400, 404]);
  const verify = async (k, apiKey, secret) => {
    if (!secret) return v1(k, apiKey);
    const r = await v2(k, secret);
    if (r === "valid" || !apiKey) return r;
    if (r === "auth" || r === "down") return v1(k, apiKey);   // nas secret odmitnut / v2 nejde -> zaloha pres API klic uctu
    const r1 = await v1(k, apiKey);                       // v2 "neznamy klic" -> over pres v1 (v1 je omezene product_linkem)
    if (r1 === "valid") { mismatch = true; return "valid"; }
    return "invalid";                                     // v1 nefunguje / taky neuznal -> drz se v2
  };
  const norm = key.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "").toUpperCase();
  const run = async (apiKey, secret) => {
    let r = await verify(key, apiKey, secret);
    if (r !== "valid" && norm && norm !== key) {
      const r2 = await verify(norm, apiKey, secret);
      // normalizovany klic je smerodatny; raw "invalid" jen rika, ze surovy retezec neni klic
      if (r2 === "valid" || r2 === "invalid" || r === "invalid") r = r2;
    }
    return r;
  };
  let res = await run(API_KEY, SECRET);
  // Oba nase klice odmitnute a vypadaji PROHOZENE (product secret zacina "prod_sk_" a sedi v PAYHIP_API_KEY, nebo
  // PAYHIP_PRODUCT_SECRET tak nezacina) -> zkusit je obracene, at platici zakaznici nejsou bez aktualizaci,
  // a nahlasit to (srv-update-swapped). Ciste spatne hodnoty (oba "spravneho tvaru") nic navic nevolaji.
  // "invalid" z prohozeneho poradi plati, jen kdyz v nem Payhip neodmitl ZADNOU z nasich hodnot - jinak by secret
  // jineho produktu v PAYHIP_API_KEY (v2 400 na vsechno) dal 403 "neplatny klic" vsem platicim (incident 17.10.).
  let swapped = false;
  if (res === "auth" && API_KEY && SECRET && API_KEY !== SECRET && looksSwapped(API_KEY, SECRET)) {
    const n0 = authFails.length;
    const rs = await run(SECRET, API_KEY);
    if (rs === "valid" || (rs === "invalid" && authFails.length === n0)) { swapped = true; res = rs; }   // down = nevime
  }
  const fails = swapped ? "" : [...new Set(authFails)].join(" / ");
  if (swapped) later(logSrv(env, "srvflag_update_swapped", "srv-update-swapped",
    "Payhip rejected PAYHIP_API_KEY / PAYHIP_PRODUCT_SECRET as set, but accepts them swapped - updates work via the swapped values; swap them back in Cloudflare and redeploy"));
  if (res === "auth") {
    later(logSrv(env, "srvflag_update_auth", "srv-update-auth",
      "Payhip " + (fails || "?") + ": our API credentials were rejected - customers cannot update (check PAYHIP_API_KEY / PAYHIP_PRODUCT_SECRET in Cloudflare)"));
    return AUTH503();
  }
  if (fails) later(logSrv(env, "srvflag_update_degraded", "srv-update-degraded",
    "Payhip " + fails + ": one of our API credentials was rejected, updates now depend on the other one (check PAYHIP_API_KEY / PAYHIP_PRODUCT_SECRET in Cloudflare)"));
  if (mismatch) later(logSrv(env, "srvflag_update_mismatch", "srv-update-mismatch",
    "Payhip v2 rejected a key that v1 accepts - PAYHIP_PRODUCT_SECRET is probably for another product (or PAYHIP_PRODUCT is wrong)"));
  if (res === "down") return json({ ok: false, error: "license server unavailable, try again later" }, 503);
  if (res !== "valid") return json({ ok: false, error: "invalid license key" }, 403);
  if (check) return json({ ok: true });

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

// Dotaz na Payhip: { s: status } / { s, ok: true, j: telo nebo null }; sitova chyba (i neplatna hlavicka) = s 0
async function askPayhip(u, headers) {
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
}

// orez hodnoty z dashboardu: Payhip klice jsou tisknutelne ASCII bez mezer -> pryc vse ostatni (mezery, zalomeni,
// neviditelne a bidi znaky, typograficke uvozovky), pak jedny obalujici ASCII uvozovky
function cleanCred(v) {
  let s = String(v == null ? "" : v).replace(/[^\x21-\x7E]/g, "");
  const m = /^(["'`])(.*)\1$/.exec(s);
  if (m) s = m[2];
  return s;
}
const isSecretShape = (s) => /^prod_sk_/i.test(s);
// stejna podminka pro zkousku prohozeni v onRequest i pro verdikt diagnostiky
const looksSwapped = (apiKey, secret) => isSecretShape(apiKey) || !isSecretShape(secret);

// ---------- diagnostika nasich Payhip klicu (jen s ADMIN_TOKEN) ----------
//   GET /api/update?diag=1&token=ADMIN_TOKEN
// Vrati jen TVAR hodnot (delka, uvozovky, mezery, prefix prod_sk_, otisk fp8) a zivy test u Payhipu
// s vymyslenym licencnim klicem v obou poradich. Hodnoty klicu ani secretu nikdy neopusti server.
// fp8 = prvnich 8 hex sha256("pitwise-diag:" + hodnota) - zamerne NE sha256(hodnota), to je podpis Payhip webhooku.
// Payhip (zmereno 18.10.2026): v1 dobry API key + neznamy klic = 200 data:[], spatny = 401;
//                               v2 dobry secret + neznamy klic = 400 (404), spatny = 401.
// Vymysleny klic NEOVERI, ze secret patri produktu mquCD (secret jineho produktu taky da 400) - to umi jen skutecny klic.
async function diag(env, url, json, API_KEY, SECRET, product) {
  const token = url.searchParams.get("token") || "";
  if (!env.ADMIN_TOKEN || !safeEq(token, String(env.ADMIN_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);
  const shape = async (raw, clean) => {
    const r = String(raw == null ? "" : raw);
    return {
      set: !!clean, len: r.length, cleanLen: clean.length, cleanedUp: r !== clean,
      quoted: /^[^\x21-\x7E]*["'`\u2018\u2019\u201C\u201D]/.test(r), whitespace: /\s/.test(r), nonAscii: /[^\x20-\x7E]/.test(r),
      looksLikeProductSecret: isSecretShape(clean), fp8: clean ? (await sha256hex("pitwise-diag:" + clean)).slice(0, 8) : "",
    };
  };
  const DUMMY = "PWDIAG-0000-0000-0000";
  const p1 = async (c) => {
    if (!c) return { http: null, means: "not set" };
    const r = await askPayhip("https://payhip.com/api/v1/license/verify?product_link=" + encodeURIComponent(product) +
      "&license_key=" + DUMMY, { "payhip-api-key": c });
    const means = r.s === 401 || r.s === 403 ? "rejected" : r.ok && r.j ? "accepted" : "unclear";
    return { http: r.s, means };
  };
  const p2 = async (c) => {
    if (!c) return { http: null, means: "not set" };
    const r = await askPayhip("https://payhip.com/api/v2/license/verify?license_key=" + DUMMY, { "product-secret-key": c });
    const means = r.s === 401 || r.s === 403 ? "rejected" : r.s === 400 || r.s === 404 || (r.ok && r.j) ? "accepted" : "unclear";
    return { http: r.s, means };
  };
  const probe = {
    v1_with_PAYHIP_API_KEY: await p1(API_KEY), v2_with_PAYHIP_PRODUCT_SECRET: await p2(SECRET),
    v1_with_PAYHIP_PRODUCT_SECRET: await p1(SECRET), v2_with_PAYHIP_API_KEY: await p2(API_KEY),
  };
  const a = probe.v1_with_PAYHIP_API_KEY.means, b = probe.v2_with_PAYHIP_PRODUCT_SECRET.means;
  const sa = probe.v1_with_PAYHIP_PRODUCT_SECRET.means, sb = probe.v2_with_PAYHIP_API_KEY.means;
  let verdict;
  if (a === "accepted" || b === "accepted") verdict = a === "accepted" && b === "accepted" ? "ok" : a === "accepted" ? "ok-api-key-only" : "ok-product-secret-only";
  else if (sa === "accepted" || sb === "accepted")
    // stejna podminka jako zkouska prohozeni v onRequest - jinak by diag slibovala "jde to", kdyz update dava 503
    verdict = API_KEY && SECRET && API_KEY !== SECRET && looksSwapped(API_KEY, SECRET) ? "swapped" : "wrong-variable";
  else if ([a, b, sa, sb].includes("unclear")) verdict = "payhip-unclear";
  else verdict = "both-rejected";
  const binding = " (checked with a made-up license key: Payhip accepts the credential, but that it belongs to product " + product +
    " is NOT verified - a real paid key must download the file)";
  let hint = {
    "ok": "Both values are accepted by Payhip" + binding + ".",
    "ok-api-key-only": "PAYHIP_API_KEY is accepted, PAYHIP_PRODUCT_SECRET is not (or is missing) - updates go via v1" + binding + ".",
    "ok-product-secret-only": "PAYHIP_PRODUCT_SECRET is accepted, PAYHIP_API_KEY is not (or is missing) - updates go via v2" + binding + ".",
    "swapped": "The two values are swapped in Cloudflare - updates work via the swapped order, but swap them back and redeploy.",
    "wrong-variable": "A value is in the wrong variable - updates do NOT work until you move it: product secret (prod_sk_...) -> PAYHIP_PRODUCT_SECRET, API key -> PAYHIP_API_KEY, then redeploy.",
    "payhip-unclear": "Payhip did not give a clear answer (down / unexpected) - try again in a minute.",
    "both-rejected": "Payhip rejects both values - copy the CURRENT API key (Payhip > Account > Developer) and the product secret of " + product + " into Cloudflare and redeploy.",
  }[verdict];
  const creds = { PAYHIP_API_KEY: await shape(env.PAYHIP_API_KEY, API_KEY), PAYHIP_PRODUCT_SECRET: await shape(env.PAYHIP_PRODUCT_SECRET, SECRET) };
  if (creds.PAYHIP_API_KEY.cleanedUp || creds.PAYHIP_PRODUCT_SECRET.cleanedUp)
    hint += " Note: a value contains quotes/spaces/invisible characters - /api/update cleans them, but the webhook and refund pages use the raw value, so re-paste it cleanly.";
  return json({ ok: true, product, verdict, hint, creds, probe });
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
// porovnani v konstantnim case vuci delce tajemstvi (delka tokenu se tim neprozradi o nic vic nez jinde v API)
function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
