// Cloudflare Pages Function - KOMUNITNI REFERENCNI KOLA (Stage 2)
//   POST /api/reflap  -> kandidat na nejrychlejsi CISTE kolo per (sim|track|layout|carClass).
//                        Ulozi se JEN kdyz je rychlejsi nez dosavadni ulozene. Profil kola
//                        (np/ms/kmh/gas/brk/steer, <=600 bodu) pak stahuji vsichni jako
//                        referenci - inzenyr podle ni radi pomalejsim ("nejrychlejsi uci ostatni").
//   GET  /api/reflap?sim=&track=&layout=&carClass=  -> ulozene nejlepsi kolo (nebo 404).
// KV: binding TELEMETRY (fallback FEEDBACK), klic ref_<sim>_<track>_<layout>_<carClass>.
// Zadna osobni data - jen anonymni aid (hash instalace) kvuli dedup/abuse.
// Velikost: 600 bodu x 6 cisel ~ 40 KB JSON - hluboko pod KV limitem.

const SIMS = ["ac", "acc", "lmu", "rf2", "ir", "f1"];
const CLASSES = ["gt3", "gt4", "gt2", "gte", "lmp1", "lmp2", "lmp3", "hypercar", "f1", "formula", "tcr", "cup", "road", "kart", "other"];

function idSafe(s, max) {
  return (s || "").toString().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, max || 40);
}
function num(x) { const n = Number(x); return isFinite(n) ? n : null; }

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.TELEMETRY || env.FEEDBACK;
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
  if (!kv) return json({ ok: false, error: "KV not bound" }, 500);

  const url = new URL(request.url);

  if (request.method === "GET") {
    const sim = idSafe(url.searchParams.get("sim"), 8);
    const track = idSafe(url.searchParams.get("track"), 40);
    const layout = idSafe(url.searchParams.get("layout"), 40) || "-";
    const carClass = idSafe(url.searchParams.get("carClass"), 16) || "other";
    if (SIMS.indexOf(sim) < 0 || !track || track.length < 2) return json({ ok: false, error: "bad params" }, 400);
    let r = null;
    try { r = await kv.get("ref_" + sim + "_" + track + "_" + layout + "_" + carClass, { type: "json" }); } catch (e) {}
    if (!r || r.v !== 1) return json({ ok: false, error: "not found" }, 404);
    return json({ ok: true, ref: r });
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
    lastNp = np;
    clean.push([Math.round(np * 10000) / 10000, Math.round(t), Math.round(kmh * 10) / 10, Math.round(gas * 1000) / 1000, Math.round(brk * 1000) / 1000, Math.round(steer * 1000) / 1000]);
  }
  // profil musi pokryvat skoro cele kolo (jinak by koucink v mezerach mlcel/lhal)
  if (clean[0][0] > 0.05 || clean[clean.length - 1][0] < 0.95) return json({ ok: false, error: "prof coverage" }, 400);

  const key = "ref_" + sim + "_" + track + "_" + layout + "_" + carClass;
  let cur = null;
  try { cur = await kv.get(key, { type: "json" }); } catch (e) {}

  // ANTI-TROLL pojistka: podezrele velky skok dolu (o >12 % rychlejsi nez dosavadni rekord
  // s 10+ prispevky) neprijmame - realne zlepseni rekordu byva po desetinach
  if (cur && cur.v === 1 && cur.n >= 10 && ms < cur.ms * 0.88) return json({ ok: false, error: "implausible jump" }, 422);

  if (cur && cur.v === 1 && cur.ms <= ms) {
    // pomalejsi nez ulozene -> jen zvednout citac prispevku (statistika duvery rekordu)
    cur.n = (cur.n || 0) + 1;
    cur.updated = Date.now();
    try { await kv.put(key, JSON.stringify(cur)); } catch (e) {}
    return json({ ok: true, kept: true, best: cur.ms });
  }

  const rec = { v: 1, sim, track, layout, carClass, carModel, ms: Math.round(ms), aid, n: (cur && cur.n ? cur.n : 0) + 1, updated: Date.now(), prof: clean };
  try { await kv.put(key, JSON.stringify(rec)); } catch (e) { return json({ ok: false, error: "kv put failed" }, 500); }
  return json({ ok: true, newBest: true, ms: rec.ms });
}
