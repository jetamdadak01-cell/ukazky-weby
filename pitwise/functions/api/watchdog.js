// Cloudflare Pages Function — HLIDAC. Jednou denne shrne, co se v PitWise deje,
// a posle to majiteli do Discordu. Bez nej se o chybach zakazniku dozvi jen ten,
// kdo si sam rekne "zkontroluj errlogy" - a 440 radku za mesic lezi ladem.
//
//   GET /api/watchdog?token=XXX            -> spocita, posle notifikaci, ulozi otisk
//   GET /api/watchdog?token=XXX&dry=1      -> jen vrati JSON, nic neposle, otisk NEULOZI
//   GET /api/watchdog?token=XXX&always=1   -> posle i kdyz se nic noveho nestalo
//
// Spousti to cron v GitHub Actions (.github/workflows/pitwise-watchdog.yml) - Pages Functions
// samy neumi beh podle casu, reaguji jen na HTTP pozadavek.
//
// Vyzaduje: KV "FEEDBACK", env ADMIN_TOKEN. Volitelne: DISCORD_WEBHOOK.

const SNAP = "wd_last";

// Kategorie chyb. Poradi ROZHODUJE - prvni shoda vyhrava, takze specificke vzory patri nahoru.
const CATS = [
  ["mikrofon",   /\b(mic|ptt|whisper|wavein|mic-open|mic-format|silent|empty)\b/i],
  ["antivirus",  /(antivir|defender|zasada rizeni|application control|blocked by|quarantin)/i],
  ["ai-klic",    /(api_key_invalid|invalid.?api.?key|401|403|quota|429|billing)/i],
  ["ai-server",  /(503|502|overload|unavailable|timeout|deadline)/i],
  ["hlas",       /(piper|eleven|tts|voice|speak|audio|wasapi|winmm)/i],
  ["aktualizace",/(update|download|0xc0000142|unzip|zip|manifest)/i],
  ["telemetrie", /(shared ?memory|acpmf|rfactor|rf2|iracing|lmu|plugin|telemetr)/i],
  ["volant",     /(rawinput|joystick|wheel|hid|bind)/i],
];

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.FEEDBACK;
  const url = new URL(request.url);
  const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  if (!kv) return json({ ok: false, error: "KV not bound (FEEDBACK)" }, 500);
  if (!env.ADMIN_TOKEN || (url.searchParams.get("token") || "") !== env.ADMIN_TOKEN) return json({ ok: false, error: "unauthorized" }, 401);

  const dry = url.searchParams.get("dry") === "1";
  const always = url.searchParams.get("always") === "1";
  const now = Date.now();
  let snap = null;
  try { snap = JSON.parse((await kv.get(SNAP)) || "null"); } catch (e) {}
  const since = snap && snap.ts ? snap.ts : now - 86400000;   // prvni beh = poslednich 24 h

  // ---------- chyby ----------
  // Cteme JEN davky novejsi nez posledni beh - cas je primo v nazvu klice (err_<ts>_<rnd>).
  const cats = {}, vers = {}, people = {}, samples = {};
  let errNew = 0;
  for (const k of (await kv.list({ prefix: "err_" })).keys) {
    if (keyTs(k.name) <= since) continue;
    const v = await kv.get(k.name);
    if (!v) continue;
    let b = null; try { b = JSON.parse(v); } catch (e) { continue; }
    vers[b.ver || "?"] = (vers[b.ver || "?"] || 0) + 1;
    for (const it of (b.items || [])) {
      errNew++;
      const c = classify((it.src || "") + " " + (it.msg || ""));
      cats[c] = (cats[c] || 0) + 1;
      (people[c] = people[c] || new Set()).add(b.aid || "?");
      if (!samples[c]) samples[c] = ((it.src ? it.src + ": " : "") + (it.msg || "")).slice(0, 160);
    }
  }

  // ---------- feedback ----------
  const fbNew = [];
  for (const k of (await kv.list({ prefix: "fb_" })).keys) {
    if (keyTs(k.name) <= since) continue;
    const v = await kv.get(k.name);
    if (!v) continue;
    try { fbNew.push(JSON.parse(v)); } catch (e) {}
  }

  // ---------- refundy a zadosti ----------
  const rq = { pending: 0, refunded: 0, failed: 0, dryRun: 0 };
  for (const k of (await kv.list({ prefix: "rq_" })).keys) {
    const v = await kv.get(k.name);
    if (!v) continue;
    let t = null; try { t = JSON.parse(v); } catch (e) { continue; }
    if (t.status === "pending") rq.pending++;                         // nevyrizene i starsi
    if (keyTs(k.name) <= since) continue;
    if (t.status === "refunded") rq.refunded++;
    if (t.status === "failed") rq.failed++;
    if (t.status === "dry") rq.dryRun++;
  }

  // ---------- prodeje ----------
  let sales = 0, salesMoney = 0, cur = "";
  for (const k of (await kv.list({ prefix: "sale_" })).keys) {
    const v = await kv.get(k.name);
    if (!v) continue;
    let s = null; try { s = JSON.parse(v); } catch (e) { continue; }
    if ((s.seen || s.date || 0) <= since || s.refundedAt) continue;
    sales++; salesMoney += (s.price || 0); cur = cur || s.currency || "";
  }

  // ---------- co je NOVE proti minule ----------
  const prevCats = (snap && snap.cats) || {};
  const prevVers = (snap && snap.vers) || {};
  const newCats = Object.keys(cats).filter(c => !prevCats[c] && cats[c] >= 3);
  const spikes = Object.keys(cats).filter(c => prevCats[c] && cats[c] >= 5 && cats[c] >= prevCats[c] * 2);
  const newVers = Object.keys(vers).filter(v => v !== "?" && !prevVers[v]);

  const report = {
    ok: true, windowFrom: new Date(since).toISOString(), windowTo: new Date(now).toISOString(),
    errors: errNew, byCategory: cats, people: Object.fromEntries(Object.entries(people).map(([k, s]) => [k, s.size])),
    versions: vers, newCategories: newCats, spikes, newVersions: newVers,
    feedback: fbNew.length, refunds: rq, sales, salesCents: salesMoney,
    samples,
  };

  // ---------- zprava ----------
  const worth = errNew || fbNew.length || rq.pending || rq.refunded || rq.failed || rq.dryRun || sales || always;
  if (worth && env.DISCORD_WEBHOOK && !dry) {
    const L = [];
    L.push("**PitWise · denni hlaseni** (" + new Date(since).toISOString().slice(5, 16).replace("T", " ") + " -> ted)");
    if (rq.failed) L.push("**REFUND SELHAL " + rq.failed + "x - sahni na to rucne**");
    if (rq.pending) L.push("**Zadosti o refund cekaji na tebe: " + rq.pending + "**  -> https://pitwise.net/admin");
    if (rq.refunded || rq.dryRun) L.push("Refundy: " + rq.refunded + " automaticky vraceno" + (rq.dryRun ? ", " + rq.dryRun + " v dry-run (penize neodesly)" : ""));
    if (sales) L.push("Prodeje: " + sales + "x, " + (salesMoney / 100).toFixed(2) + " " + cur);
    if (newCats.length) L.push("**NOVY DRUH CHYBY:** " + newCats.map(c => c + " (" + cats[c] + "x)").join(", "));
    if (spikes.length) L.push("**SKOK:** " + spikes.map(c => c + " " + prevCats[c] + " -> " + cats[c] + "x").join(", "));
    if (newVers.length) L.push("Nova verze v provozu: " + newVers.join(", "));
    if (errNew) {
      const top = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([c, n]) => "· " + c + " " + n + "x / " + (people[c] ? people[c].size : "?") + " lidi — " + (samples[c] || "").slice(0, 90));
      L.push("Chyby (" + errNew + " radku):"); L.push(top.join("\n"));
    }
    if (fbNew.length) {
      L.push("Feedback (" + fbNew.length + "):");
      L.push(fbNew.slice(0, 3).map(f => "· " + (f.country ? "[" + f.country + "] " : "") + (f.message || "").slice(0, 120)).join("\n"));
    }
    if (!errNew && !fbNew.length && !rq.pending && !sales) L.push("Nic noveho - klid.");
    try {
      await fetch(env.DISCORD_WEBHOOK, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: L.join("\n").slice(0, 1900) }),
      });
      report.notified = true;
    } catch (e) { report.notified = false; report.notifyError = String(e).slice(0, 120); }
  }

  // otisk pro pristi porovnani (v dry rezimu se NEPREPISUJE, aby sel beh opakovat)
  if (!dry) await kv.put(SNAP, JSON.stringify({ ts: now, cats, vers }));
  return json(report);
}

function keyTs(name) { return parseInt((name.split("_")[1] || "0"), 10) || 0; }
function classify(s) {
  for (const [name, re] of CATS) if (re.test(s)) return name;
  return "ostatni";
}
