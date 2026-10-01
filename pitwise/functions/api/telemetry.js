// Cloudflare Pages Function - crowd telemetrie z aplikace PitWise (Stage 1: prumery, bez map)
//   POST /api/telemetry   -> vezme jednu session (pole lap recordu) a slouci ji do RUNNING
//                            agregatu per (sim|track|layout|carClass). NEuklada per-submission
//                            (free tier = 1000 zapisu/den; 1 zapis na session, ne na kolo).
// KV: pouzije binding "TELEMETRY" kdyz existuje, jinak spadne na "FEEDBACK" (agg_ prefix, zadna
//     kolize s fb_). Volitelny env TELEMETRY_INGEST_TOKEN = sdilene tajemstvi proti spamu (kdyz je
//     nastavene, vyzaduje se; kdyz ne, spolehame na tvrdou validaci).
// PROC VLASTNI PROMENNA (20.9.2026): reflap.js cte INGEST_TOKEN a token posila kazdy klient od 2.27.0.
//     Sem ale token NEPOSILA ZADNA vydana verze (ani 2.28.1) - Start-TelFlush v appce ho ma az od
//     verze po 2.28.1 (staged). Kdyby oba endpointy cetly tutez promennou, zapnuti ochrany reflapu by
//     potichu odriznulo prumery od VSECH uzivatelu. TELEMETRY_INGEST_TOKEN zapnout az kdyz v errlogu
//     nezbyde zadna verze <= 2.28.1.
//
// Blob v KV (klic agg_<sim>_<track>_<layout>_<carClass>):
//   { v, sim, track, layout, carClass, updated,
//     lap:{n,mean,M2,best}, fuel:{n,mean,M2}, wear:{n,mean,M2},
//     sectors:[{n,mean,M2},...], pitHist:{ "<lap>":count },
//     byCar:{ <model>:{n,fuelN,fuelMean,best,lapN,lapMean} } }   (lapN/lapMean od 30.9.2026)
//
// NEJLEPSI KOLO (lap.best, byCar.best) - oprava 30.9.2026 (audit: iRacing Oschersleben best 29,5 s
// pri prumeru 102 s, Charlotte 33 s vs 104 s, Monza GT3 1:26 vs 1:48):
//   1) do bestu jde JEN kolo s clean === true. Klient posila clean u KAZDEHO kola od 2.26.x
//      (Add-TelLap -> Persist-TelSession, = neni CurLapCut); kolo BEZ priznaku (starsi/cizi klient)
//      se zapocita do prumeru, ale nejlepsi cas z nej nebude. Pozor: iRacing/F1 nemaji signal
//      platnosti kola -> u nich je clean vzdy true, proto jeste bod 2.
//   2) kolo pod BEST_MIN_RATIO x prumer (kdyz uz je aspon BEST_GATE_N kol) se do bestu nepocita:
//      glitch casomiry / mix layoutu pod jednim klicem (layout klient zatim neposila). Best vozu se
//      meri proti prumeru TOHO vozu (lapMean), jakmile ma BEST_GATE_N_CAR kol, do te doby proti
//      prumeru tridy (stejne jako to cte averages.js).
//   3) SAMOOPRAVA: ulozeny best, ktery uz bodem 2 neprojde, se pri dalsim POSTu zahodi (null)
//      a znovu se naplni z NASLEDUJICICH cistych kol (rychlejsi ciste kolo z doby pred samoopravou
//      se uz nevrati - per-kolo historie se neuklada). averages.js ho do te doby stejne neukaze.

const SIMS = ["ac", "acc", "lmu", "rf2", "ir", "f1", "ams2"];
const BEST_MIN_RATIO = 0.80;   // stejny prah jako averages.js (naladeno na zivych datech 30.9.2026)
const BEST_GATE_N = 20;        // = MIN_LAPS v averages.js
const BEST_GATE_N_CAR = 10;
const CLASSES = ["gt3", "gt4", "gt2", "gte", "lmp1", "lmp2", "lmp3", "hypercar", "f1", "formula", "tcr", "cup", "road", "kart", "other"];

function idSafe(s, max) {
  return (s || "").toString().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, max || 40);
}
// Welfordovo online sloucení jednoho vzorku do {n,mean,M2}
function fold(acc, x) {
  if (!acc) acc = { n: 0, mean: 0, M2: 0 };
  acc.n += 1;
  const d = x - acc.mean;
  acc.mean += d / acc.n;
  acc.M2 += d * (x - acc.mean);
  return acc;
}
function num(x) { const n = Number(x); return isFinite(n) ? n : null; }
// cas kola je uveritelny kandidat na best vuci prumeru (pod gate prahem poctu kol vzdy ano)
function bestPlausible(ms, mean, n, gateN) { return !(n >= gateN && mean > 0 && ms < BEST_MIN_RATIO * mean); }
// best vozu: proti prumeru vozu (az ma BEST_GATE_N_CAR kol), jinak proti prumeru tridy
function carBestPlausible(ms, bc, lap) {
  if ((bc.lapN || 0) >= BEST_GATE_N_CAR) return bestPlausible(ms, bc.lapMean, bc.lapN, BEST_GATE_N_CAR);
  return lap ? bestPlausible(ms, lap.mean, lap.n, BEST_GATE_N) : true;
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.TELEMETRY || env.FEEDBACK;
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });

  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  if (!kv) return json({ ok: false, error: "KV not bound (TELEMETRY/FEEDBACK)" }, 500);

  // volitelna ochrana proti spamu: kdyz je TELEMETRY_INGEST_TOKEN nastaveny, musi sedet (viz hlavicka)
  const need = env.TELEMETRY_INGEST_TOKEN || "";
  if (need) {
    const got = request.headers.get("x-ingest-token") || new URL(request.url).searchParams.get("t") || "";
    if (got !== need) return json({ ok: false, error: "unauthorized" }, 401);
  }

  let data = {};
  try { data = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }

  const sim = idSafe(data.sim, 8);
  const track = idSafe(data.track, 40);
  const layout = idSafe(data.layout, 40) || "-";
  const carClass = idSafe(data.carClass, 16) || "other";
  if (SIMS.indexOf(sim) < 0) return json({ ok: false, error: "bad sim" }, 400);
  if (!track || track.length < 2) return json({ ok: false, error: "bad track" }, 400);
  if (CLASSES.indexOf(carClass) < 0) return json({ ok: false, error: "bad carClass" }, 400);

  // PowerShell 5.1 ConvertTo-Json rozbaluje jednoprvkove pole na objekt -> tolerujeme obojí
  let laps = data.laps;
  if (laps && !Array.isArray(laps)) laps = [laps];
  if (!Array.isArray(laps) || laps.length === 0 || laps.length > 200) return json({ ok: false, error: "bad laps count" }, 400);

  const key = "agg_" + sim + "_" + track + "_" + layout + "_" + carClass;
  let a = null;
  try { a = await kv.get(key, { type: "json" }); } catch (e) {}
  if (!a || a.v !== 1) {
    a = { v: 1, sim, track, layout, carClass, updated: 0, lap: null, fuel: null, wear: null, sectors: [], pitHist: {}, byCar: {} };
  }

  if (!a.byCar || typeof a.byCar !== "object") a.byCar = {};
  if (!a.pitHist || typeof a.pitHist !== "object") a.pitHist = {};
  if (!Array.isArray(a.sectors)) a.sectors = [];
  // SAMOOPRAVA (viz hlavicka, bod 3): neuveritelny ulozeny best zahodit, dalsi cista kola ho naplni
  if (a.lap && a.lap.best != null && !bestPlausible(a.lap.best, a.lap.mean, a.lap.n, BEST_GATE_N)) a.lap.best = null;
  for (const m in a.byCar) {
    const bc = a.byCar[m];
    if (bc && bc.best != null && !carBestPlausible(bc.best, bc, a.lap)) bc.best = null;
  }

  let accepted = 0;
  for (const L of laps) {
    if (!L || typeof L !== "object") continue;
    const ms = num(L.ms);
    // rozsahy = stejne sanity jako v appce (kolo 20s..15min, palivo 0.05..30 L)
    if (ms === null || ms < 20000 || ms > 900000) continue;
    // PS 5.1 ConvertTo-Json dava true/false; retezec "true" tolerujeme. Chybejici priznak = NE.
    const clean = L.clean === true || L.clean === "true";
    a.lap = fold(a.lap, ms);
    if (clean && bestPlausible(ms, a.lap.mean, a.lap.n, BEST_GATE_N) && (a.lap.best == null || ms < a.lap.best)) a.lap.best = ms;

    const fuelL = num(L.fuelL);
    if (fuelL !== null && fuelL >= 0.05 && fuelL <= 30) a.fuel = fold(a.fuel, fuelL);

    const wear = num(L.wearPctPerLap);
    if (wear !== null && wear >= 0 && wear <= 100) a.wear = fold(a.wear, wear);

    if (Array.isArray(L.sectors)) {
      for (let i = 0; i < L.sectors.length && i < 6; i++) {
        const s = num(L.sectors[i]);
        if (s !== null && s > 1000 && s < 600000) a.sectors[i] = fold(a.sectors[i], s);
      }
    }

    const pit = num(L.pitLap);
    if (pit !== null && pit >= 1 && pit <= 999) { const pk = String(Math.round(pit)); a.pitHist[pk] = (a.pitHist[pk] || 0) + 1; }

    // per-carModel: palivo a nejlepsi kolo (palivo je hodne car-specific); lapN/lapMean = prumer
    // kola TOHO vozu (starsi bloby ho nemaji -> pocita se od 30.9.2026) pro kontrolu bestu vozu
    const cm = idSafe(L.carModel, 48);
    if (cm) {
      let bc = a.byCar[cm] || { n: 0, fuelN: 0, fuelMean: 0, best: null };
      bc.n += 1;
      bc.lapN = (bc.lapN || 0) + 1;
      bc.lapMean = (bc.lapMean || 0) + (ms - (bc.lapMean || 0)) / bc.lapN;
      if (clean && carBestPlausible(ms, bc, a.lap) && (bc.best == null || ms < bc.best)) bc.best = ms;
      if (fuelL !== null && fuelL >= 0.05 && fuelL <= 30) { bc.fuelN += 1; bc.fuelMean += (fuelL - bc.fuelMean) / bc.fuelN; }
      a.byCar[cm] = bc;
    }
    accepted++;
  }

  if (accepted === 0) return json({ ok: false, error: "no valid laps" }, 400);

  // strop velikosti byCar (bezpecnost): drz max ~60 modelu, nejmensimi n zahod
  const models = Object.keys(a.byCar);
  if (models.length > 60) {
    models.sort((x, y) => a.byCar[x].n - a.byCar[y].n);
    for (let i = 0; i < models.length - 60; i++) delete a.byCar[models[i]];
  }

  a.updated = Date.now();
  try { await kv.put(key, JSON.stringify(a)); } catch (e) { return json({ ok: false, error: "kv put failed" }, 500); }

  return json({ ok: true, accepted, n: a.lap ? a.lap.n : 0 });
}
