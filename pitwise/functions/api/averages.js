// Cloudflare Pages Function - servíruje KOMUNITNI PRUMERY pro PitWise (Stage 1)
//   GET /api/averages?sim=&track=&layout=&carClass=&carModel=
//        -> vrati agregovane prumery (kolo/palivo/opotrebeni/sektory/pit lap) z KV.
// CORS zapnute (na rozdil od feedback.js): tyto prumery muze cist i prohlizec/web.
// Cte stejny blob, ktery zapisuje telemetry.js (klic agg_<sim>_<track>_<layout>_<carClass>).

const SIMS = ["ac", "acc", "lmu", "rf2", "ir", "f1", "ams2"];
const MIN_LAPS = 20;   // pod timto poctem NEreportujeme "komunitni" cislo (aby to nebyl 1 clovek)
// UVERITELNOST BESTU (30.9.2026): best se vrati jen kdyz je >= 80 % prumeru, jinak null -> klient
// (Apply-CrowdResult: [int]$null = 0, Get-CrowdRefMs/Get-RefLap berou jen > 0) spadne na best vozu,
// pak na pevnou tabulku. Naladeno na 48 zivych klicich (1.10.2026): nesmysly 0,29-0,80 (iRacing
// Oschersleben 29,5 s / 102 s, Charlotte 33 s / 104 s, Bathurst GT3 80,6 s / 127 s, Monza GT3
// 86,4 s / 108,5 s), realne besty s prumerem nafouknutym out-lapy/boxy 0,82-0,83 (AC i ACC Spa GT3,
// rF2 COTA GT3) - 0,85 by je schovalo. Pasmo 0,79-0,82 je smisene (Charlotte other 0,798 nejspis
// realny ovalovy cas -> schovan; Road America GT3 0,817 nejspis mix layoutu -> ukazan). Best vozu se
// meri proti prumeru TOHO vozu (lapMean z telemetry.js, od 30.9.2026), dokud nema CAR_MIN_LAPS kol,
// tak proti prumeru tridy.
const BEST_MIN_RATIO = 0.80;
const CAR_MIN_LAPS = 10;

function idSafe(s, max) {
  return (s || "").toString().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, max || 40);
}
function meanOf(a) { return a && a.n > 0 ? a.mean : null; }
function plausibleBest(best, mean) { return best != null && isFinite(best) && best > 0 && mean > 0 && best >= BEST_MIN_RATIO * mean; }
function pitMode(hist) {
  let best = null, bestC = -1;
  for (const k in hist) { if (hist[k] > bestC) { bestC = hist[k]; best = parseInt(k, 10); } }
  return best;
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.TELEMETRY || env.FEEDBACK;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  const json = (obj, status = 200, extra = {}) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", ...cors, ...extra } });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, error: "method" }, 405);
  if (!kv) return json({ ok: false, error: "KV not bound (TELEMETRY/FEEDBACK)" }, 500);

  const u = new URL(request.url);
  const sim = idSafe(u.searchParams.get("sim"), 8);
  const track = idSafe(u.searchParams.get("track"), 40);
  const layout = idSafe(u.searchParams.get("layout"), 40) || "-";
  const carClass = idSafe(u.searchParams.get("carClass"), 16) || "other";
  const carModel = idSafe(u.searchParams.get("carModel"), 48);
  if (SIMS.indexOf(sim) < 0 || !track) return json({ ok: false, error: "bad params" }, 400);

  const key = "agg_" + sim + "_" + track + "_" + layout + "_" + carClass;
  let a = null;
  try { a = await kv.get(key, { type: "json" }); } catch (e) {}
  if (!a || a.v !== 1 || !a.lap || a.lap.n < MIN_LAPS) {
    // malo dat (nebo zadna) -> klient poctive spadne na sve lokalni/hardcoded hodnoty
    return json({ ok: true, enough: false, minLaps: MIN_LAPS, n: a && a.lap ? a.lap.n : 0 }, 200, { "Cache-Control": "public, max-age=120" });
  }

  const avg = {
    lapMsAvg: Math.round(meanOf(a.lap)),
    lapMsBest: plausibleBest(a.lap.best, a.lap.mean) ? Math.round(a.lap.best) : null,
    fuelLPerLap: meanOf(a.fuel) != null ? Math.round(meanOf(a.fuel) * 100) / 100 : null,
    wearPctPerLap: meanOf(a.wear) != null ? Math.round(meanOf(a.wear) * 100) / 100 : null,
    pitLapMode: pitMode(a.pitHist || {}),
    sectorsAvg: (a.sectors || []).map((s) => (meanOf(s) != null ? Math.round(meanOf(s)) : null)),
  };

  // per-carModel palivo/nejlepsi (palivo je hodne car-specific) - kdyz klient posle carModel
  let car = null;
  if (carModel && a.byCar && a.byCar[carModel]) {
    const bc = a.byCar[carModel];
    const carRef = (bc.lapN || 0) >= CAR_MIN_LAPS ? bc.lapMean : a.lap.mean;
    car = {
      fuelLPerLap: bc.fuelN > 0 ? Math.round(bc.fuelMean * 100) / 100 : null,
      lapMsBest: plausibleBest(bc.best, carRef) ? Math.round(bc.best) : null,
      n: bc.n,
    };
  }

  return json({ ok: true, enough: true, n: a.lap.n, sim, track, layout, carClass, updated: a.updated, avg, car }, 200, { "Cache-Control": "public, max-age=300" });
}
