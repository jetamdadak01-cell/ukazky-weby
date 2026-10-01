// Cloudflare Pages Function - KOMUNITNI REFERENCNI KOLA (Stage 2)
//   POST /api/reflap  -> kandidat na nejrychlejsi CISTE kolo per (sim|track|layout|carClass).
//                        Ulozi se JEN kdyz je rychlejsi nez dosavadni ulozene. Profil kola
//                        (np/ms/kmh/gas/brk/steer, <=600 bodu) pak stahuji vsichni jako
//                        referenci - inzenyr podle ni radi pomalejsim ("nejrychlejsi uci ostatni").
//   GET  /api/reflap?sim=&track=&layout=&carClass=  -> ulozene nejlepsi kolo (nebo 404).
//   GET    /api/reflap?token=ADMIN&list=1[&cursor=]  -> (admin) prehled ref_ zaznamu + vysledek validace
//   DELETE /api/reflap?token=ADMIN&keys=ref_a,ref_b  -> (admin) rucni moderace, max 100 klicu
// KV: binding TELEMETRY (fallback FEEDBACK), klic ref_<sim>_<track>_<layout>_<carClass>.
// Zadna osobni data - jen anonymni aid (hash instalace) kvuli dedup/abuse.
// Velikost: 600 bodu x 6 cisel ~ 40 KB JSON - hluboko pod KV limitem.
//
// VALIDACE ZAZNAMU (audit 30.9.2026: 12 ze 49 zivych ref_ zaznamu bylo vadnych - out/in-lap se
// stanim v boxu, diry v np, cas kola nesedi s profilem, posunuta casova osa). profProblem() se
// pousti na KAZDY novy POST i na KAZDY ulozeny zaznam (GET i POST). Vadny ulozeny zaznam se chova,
// jako by neexistoval: GET vrati 404 (klient ho nepouzije a zustane u vlastniho bestu) a prvni
// platny POST ho prepise. Prahy jsou naladene na tech 49 zaznamech - viz CHK.

const SIMS = ["ac", "acc", "lmu", "rf2", "ir", "f1", "ams2"];
const CLASSES = ["gt3", "gt4", "gt2", "gte", "lmp1", "lmp2", "lmp3", "hypercar", "f1", "formula", "tcr", "cup", "road", "kart", "other"];

const CHK = {
  NP_START: 0.05,     // profil musi zacit nejpozdeji v 5 % kola...
  NP_END: 0.95,       // ...a skoncit nejdriv v 95 %
  NP_GAP: 0.06,       // max skok np mezi sousednimi body (zdrave max 0.011; vadne 0.65-0.93 = chybi vetsina kola)
  NP_GAP_MS: 2500,    //   ...na kratkych tratich (ovaly ~30 s) povolit zasek UI az 2.5 s: limit = max(NP_GAP, 2500/ms)
  T0_MS: 3000,        // posun casove osy na startu t0 - np0*ms (zdrave max 1.9 s ACC Silverstone; vadne 6.6 a 7.7 s)
  T0_REL: 0.03,       //   ...relativne max(3 s, 3 % kola) - casova cara byva proti np 0 strukturalne posunuta
  DRIFT_MS: 3500,     // |trvani profilu - pokryti*ms| <= max(3.5 s, 2.5 % kola)
  DRIFT_REL: 0.025,   //   (zdrave max 2.7 s rF2 Fuji classic; vadne od 4.4 s rF2 Spa = profil jineho kola nez ms)
  STALL_MS: 3000,     // cas navic mezi 2 body oproti tempu kola = stani/vypadek (zdrave max 1.1 s; vadne 5-47 s)
  STOP_KMH: 5,        // souvisle pod 5 km/h...
  STOP_MS: 3000,      // ...dele nez 3 s = stani
  LINE_GAP: 0.06,     // stopa: max skok np (zdrave max 0.012)
  LINE_JUMP: 4,       // stopa: usek max 4x delsi, nez odpovida jeho np (zdrave max 1.7x) = teleport/reset
  LINE_JUMP_MIN_M: 100,
  LINE_MIN_M: 300,    // stopa kratsi nez 300 m = auto stalo / nesmysl
};

function idSafe(s, max) {
  return (s || "").toString().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, max || 40);
}
function num(x) { const n = Number(x); return isFinite(n) ? n : null; }
function r4(x) { return Math.round(x * 10000) / 10000; }

// Vrati "" kdyz je profil [np, tMs, kmh, gas, brk, steer] pouzitelny jako reference kola `ms`,
// jinak kratky duvod. Stejna funkce pro novy POST i pro uz ulozene zaznamy.
function profProblem(prof, ms) {
  if (ms === null || !(ms >= 20000 && ms <= 900000)) return "ms range";
  if (!Array.isArray(prof) || prof.length < 60 || prof.length > 600) return "prof size";
  let pNp = -1, pT = -1, pKmh = 0, slowMs = 0, np0 = 0;
  for (let i = 0; i < prof.length; i++) {
    const p = prof[i];
    if (!Array.isArray(p) || p.length < 5) return "prof point";
    const np = num(p[0]), t = num(p[1]), kmh = num(p[2]);
    if (np === null || t === null || kmh === null) return "prof num";
    if (np < 0 || np > 1.0001 || np <= pNp) return "np not monotonic";
    if (t < 0 || t > ms + 5000) return "time range";
    if (i > 0) {
      if (t < pT) return "time not monotonic";
      const dNp = np - pNp, dT = t - pT;
      if (dNp > Math.max(CHK.NP_GAP, CHK.NP_GAP_MS / ms)) return "np gap " + r4(pNp) + "-" + r4(np);
      // iRacing hlasi prvni ~2 s kola cas 0 (LapCurrentLapTime se nuluje pozde): prvni nenulovy cas
      // se proto nemeri od predchoziho bodu, ale od zacatku profilu (nula muze byt jen na zacatku -
      // cas neklesa). Dlouhe stani schovane v nulovem useku (auto v boxu) se tak porad chyti.
      const excess = pT > 0 ? dT - dNp * ms : t - np * ms;   // casomira startuje na care (np 0), ne v np0
      if (excess > CHK.STALL_MS) return "stall " + Math.round(excess / 1000) + " s at np " + r4(np);
      if (kmh < CHK.STOP_KMH && pKmh < CHK.STOP_KMH) { slowMs += dT; if (slowMs > CHK.STOP_MS) return "stopped at np " + r4(np); }
      else slowMs = 0;
    }
    if (i === 0) np0 = np;
    pNp = np; pT = t; pKmh = kmh;
  }
  const f = prof[0], l = prof[prof.length - 1];
  if (f[0] > CHK.NP_START || l[0] < CHK.NP_END) return "coverage " + r4(f[0]) + "-" + r4(l[0]);
  // cas prvniho bodu musi odpovidat jeho poloze (t0 ~ np0*ms); velky kladny posun = casomira
  // bezela uz pred startem profilu (kolo z boxu / jine kolo)
  const off0 = f[1] - f[0] * ms;
  if (off0 > Math.max(CHK.T0_MS, CHK.T0_REL * ms)) return "t0 offset " + Math.round(off0 / 100) / 10 + " s";
  // profil musi trvat tolik, kolik rika cas kola (na pokryte casti) - jinak je to profil JINEHO kola
  const drift = (l[1] - f[1]) - (l[0] - f[0]) * ms;
  if (Math.abs(drift) > Math.max(CHK.DRIFT_MS, CHK.DRIFT_REL * ms)) return "time vs ms " + Math.round(drift / 100) / 10 + " s";
  return "";
}

// Volitelna stopa [np, x, z]: "" = pouzitelna. Vadna stopa se jen zahodi, zaznam zustava.
function lineProblem(line) {
  if (!Array.isArray(line) || line.length < 60 || line.length > 400) return "line size";
  let pNp = -1, px = 0, pz = 0, total = 0;
  const seg = [];
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    if (!Array.isArray(p) || p.length < 3) return "line point";
    const np = num(p[0]), x = num(p[1]), z = num(p[2]);
    if (np === null || x === null || z === null) return "line num";
    if (np < 0 || np > 1.0001 || np <= pNp) return "line np not monotonic";
    if (x < -1000000 || x > 1000000 || z < -1000000 || z > 1000000) return "line range";
    if (i > 0) {
      if (np - pNp > CHK.LINE_GAP) return "line np gap";
      const d = Math.hypot(x - px, z - pz);
      seg.push([np - pNp, d]); total += d;
    }
    pNp = np; px = x; pz = z;
  }
  const f = line[0][0], l = line[line.length - 1][0];
  if (f > CHK.NP_START || l < CHK.NP_END) return "line coverage";
  if (total < CHK.LINE_MIN_M) return "line too short";
  const cov = l - f;
  for (const [dNp, d] of seg) {
    if (d > Math.max(CHK.LINE_JUMP_MIN_M, CHK.LINE_JUMP * (dNp / cov) * total)) return "line jump";
  }
  return "";
}

// ulozeny zaznam je pouzitelny? ("" = ano)
function recProblem(r) {
  if (!r || r.v !== 1) return "version";
  return profProblem(r.prof, num(r.ms));
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.TELEMETRY || env.FEEDBACK;
  const admin = env.ADMIN_TOKEN || "";
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
  if (!kv) return json({ ok: false, error: "KV not bound" }, 500);

  const url = new URL(request.url);
  const isAdmin = () => !!admin && (url.searchParams.get("token") || "") === admin;

  // ADMIN: rucni moderace (stejny vzor jako setup.js) - smaze vadne zaznamy, ktere nejdou opravit
  if (request.method === "DELETE") {
    if (!isAdmin()) return json({ ok: false, error: "unauthorized" }, 401);
    const keys = (url.searchParams.get("keys") || "").split(",").map((s) => s.trim())
      .filter((k) => /^ref_[a-z0-9_-]{3,200}$/.test(k)).slice(0, 100);
    if (!keys.length) return json({ ok: false, error: "no keys" }, 400);
    let deleted = 0;
    for (const k of keys) { try { await kv.delete(k); deleted++; } catch (e) {} }
    return json({ ok: true, deleted });
  }

  if (request.method === "GET") {
    // ADMIN prehled: ref_ zaznamy + proc je validace odmita (strankovane kvuli limitu KV operaci)
    if (url.searchParams.has("token")) {
      if (!isAdmin()) return json({ ok: false, error: "unauthorized" }, 401);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));   // 20 zaznamu ~ par ms CPU (free tier 10 ms)
      const opts = { prefix: "ref_", limit };
      const cursor = url.searchParams.get("cursor") || "";
      if (cursor) opts.cursor = cursor;
      let l = null;
      try { l = await kv.list(opts); } catch (e) { return json({ ok: false, error: "kv list failed" }, 500); }
      const items = [];
      for (const k of l.keys) {
        let r = null;
        try { r = await kv.get(k.name, { type: "json" }); } catch (e) {}
        if (!r) continue;
        items.push({
          key: k.name, ms: r.ms, n: r.n, carModel: r.carModel, updated: r.updated,
          pts: Array.isArray(r.prof) ? r.prof.length : 0, line: Array.isArray(r.line) ? r.line.length : 0,
          problem: recProblem(r), lineProblem: r.line ? lineProblem(r.line) : "",
        });
      }
      return json({ ok: true, count: items.length, bad: items.filter((x) => x.problem).length, cursor: l.list_complete ? null : (l.cursor || null), items });
    }

    const sim = idSafe(url.searchParams.get("sim"), 8);
    const track = idSafe(url.searchParams.get("track"), 40);
    const layout = idSafe(url.searchParams.get("layout"), 40) || "-";
    const carClass = idSafe(url.searchParams.get("carClass"), 16) || "other";
    if (SIMS.indexOf(sim) < 0 || !track || track.length < 2) return json({ ok: false, error: "bad params" }, 400);
    let r = null;
    try { r = await kv.get("ref_" + sim + "_" + track + "_" + layout + "_" + carClass, { type: "json" }); } catch (e) {}
    // vadny zaznam = jako by nebyl (klient by z nej koucoval nesmysly)
    if (!r || recProblem(r)) return json({ ok: false, error: "not found" }, 404);
    // aid nezverejnovat (anonymni, ale umoznil by korelaci drzitele rekordu napric tratemi)
    const { aid: _aid, ...pub } = r;
    if (pub.line && lineProblem(pub.line)) delete pub.line;   // vadna stopa pryc, profil zustava
    return json({ ok: true, ref: pub });
  }

  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  // volitelna ochrana proti spamu (stejny vzor jako telemetry.js)
  const need = env.INGEST_TOKEN || "";
  if (need) {
    const got = request.headers.get("x-ingest-token") || url.searchParams.get("t") || "";
    if (got !== need) return json({ ok: false, error: "unauthorized" }, 401);
  }

  let data = {};
  try { data = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }

  const sim = idSafe(data.sim, 8);
  const track = idSafe(data.track, 40);
  const layout = idSafe(data.layout, 40) || "-";
  const carClass = idSafe(data.carClass, 16) || "other";
  const carModel = idSafe(data.carModel, 48) || "";
  const aid = idSafe(data.aid, 24) || "";
  const ms = num(data.ms);
  if (SIMS.indexOf(sim) < 0) return json({ ok: false, error: "bad sim" }, 400);
  if (!track || track.length < 2) return json({ ok: false, error: "bad track" }, 400);
  if (CLASSES.indexOf(carClass) < 0) return json({ ok: false, error: "bad carClass" }, 400);
  if (ms === null || ms < 20000 || ms > 900000) return json({ ok: false, error: "bad ms" }, 400);

  // profil: pole [np, tMs, kmh, gas, brk, steer]; np MONOTONNE roste 0..1, cisla konecna
  let prof = data.prof;
  if (!Array.isArray(prof) || prof.length < 60 || prof.length > 600) return json({ ok: false, error: "bad prof size" }, 400);
  const clean = [];
  let lastNp = -1;
  for (const p of prof) {
    if (!Array.isArray(p) || p.length < 5) return json({ ok: false, error: "bad prof point" }, 400);
    const np = num(p[0]), t = num(p[1]), kmh = num(p[2]), gas = num(p[3]), brk = num(p[4]);
    const steer = p.length > 5 ? (num(p[5]) || 0) : 0;
    if (np === null || t === null || kmh === null || gas === null || brk === null) return json({ ok: false, error: "bad prof num" }, 400);
    if (np < 0 || np > 1.0001 || np <= lastNp) return json({ ok: false, error: "prof not monotonic" }, 400);
    if (t < 0 || t > ms + 5000) return json({ ok: false, error: "prof time range" }, 400);
    if (kmh < 0 || kmh > 500 || gas < 0 || gas > 1.01 || brk < 0 || brk > 1.01) return json({ ok: false, error: "prof value range" }, 400);
    if (steer < -3 || steer > 3) return json({ ok: false, error: "prof value range" }, 400);
    lastNp = np;
    const rnp = Math.round(np * 10000) / 10000;
    // klient kvantizuje np na 4 mista (Get-NpQuant); kdyby poslal jemnejsi, zaokrouhleni by
    // udelalo duplicitu -> bod zahodit (drive se ulozil a ulozeny profil nebyl rostouci)
    if (clean.length && rnp <= clean[clean.length - 1][0]) continue;
    clean.push([rnp, Math.round(t), Math.round(kmh * 10) / 10, Math.round(gas * 1000) / 1000, Math.round(brk * 1000) / 1000, Math.round(steer * 1000) / 1000]);
  }
  // profil musi pokryvat skoro cele kolo (jinak by koucink v mezerach mlcel/lhal)
  if (clean[0][0] > CHK.NP_START || clean[clean.length - 1][0] < CHK.NP_END) return json({ ok: false, error: "prof coverage" }, 400);
  // obsahova validace (diry, stani, casova osa vs cas kola) - stejna jako pri cteni ulozeneho zaznamu
  const why = profProblem(clean, ms);
  if (why) { console.log("reflap 422", sim, track, carClass, ms, why); return json({ ok: false, error: "bad prof: " + why }, 422); }   // viditelne v CF real-time logs

  // VOLITELNA STOPA (Stage 2): [np, x, z] <=400 bodu - absolutni herni souradnice rekordniho
  // kola. Klienti si ji promitnou na SVOU mapu -> rady o najezdu/apexu/vyjezdu. Bez stopy
  // (iRacing bez pozice) se zaznam prijme taky - koucink jede jen z pedalu/rychlosti.
  // Vadna stopa (diry, teleport, nesmyslna delka) se zahodi, profil se prijme bez ni.
  let line = null;
  if (Array.isArray(data.line) && data.line.length >= 60 && data.line.length <= 400) {
    const lc = [];
    let okL = true, lnp = -1;
    for (const p of data.line) {
      if (!Array.isArray(p) || p.length < 3) { okL = false; break; }
      const np = num(p[0]), x = num(p[1]), z = num(p[2]);
      if (np === null || x === null || z === null || np <= lnp) { okL = false; break; }
      lnp = np;
      const rnp = Math.round(np * 10000) / 10000;
      if (lc.length && rnp <= lc[lc.length - 1][0]) continue;   // duplicita po zaokrouhleni (viz profil)
      lc.push([rnp, Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
    }
    if (okL && !lineProblem(lc)) line = lc;
  }

  const key = "ref_" + sim + "_" + track + "_" + layout + "_" + carClass;
  let cur = null;
  try { cur = await kv.get(key, { type: "json" }); } catch (e) {}
  // vadny ulozeny zaznam = jako by nebyl: prvni platny POST ho prepise (i kdyz je "pomalejsi"),
  // citac n zacina znovu (historie vadneho zaznamu nic neznamena)
  if (cur && recProblem(cur)) cur = null;

  // ANTI-TROLL pojistka: podezrele velky skok dolu (o >12 % rychlejsi nez dosavadni rekord
  // s 10+ prispevky) neprijmame - realne zlepseni rekordu byva po desetinach
  if (cur && cur.n >= 10 && ms < cur.ms * 0.88) return json({ ok: false, error: "implausible jump" }, 422);

  if (cur && cur.ms <= ms) {
    // pomalejsi nez ulozene -> citac prispevku zvednout JEN dokud ma vyznam (anti-troll prah
    // n>=10) - jinak by kazdy pomalejsi POST palil KV zapis (free tier 1000 zapisu/den).
    // 'updated' = cas VYMENY rekordu (driv ho prepisoval i pomalejsi POST) -> tady jen lastSeen
    cur.n = (cur.n || 0) + 1;
    if (cur.n <= 11) { cur.lastSeen = Date.now(); try { await kv.put(key, JSON.stringify(cur)); } catch (e) {} }
    return json({ ok: true, kept: true, best: cur.ms });
  }

  const rec = { v: 1, sim, track, layout, carClass, carModel, ms: Math.round(ms), aid, n: (cur && cur.n ? cur.n : 0) + 1, updated: Date.now(), prof: clean };
  if (line) rec.line = line;
  try { await kv.put(key, JSON.stringify(rec)); } catch (e) { return json({ ok: false, error: "kv put failed" }, 500); }
  return json({ ok: true, newBest: true, ms: rec.ms });
}
