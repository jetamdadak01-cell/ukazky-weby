// Cloudflare Pages Function — licencovane auto-aktualizace PitWise
//   GET /api/update?file=ps1|exe&key=LICENCNI-KLIC
//   1) overi licencni klic u Payhipu (jen platici zakaznici)
//   2) kdyz je platny, vrati soubor z PRIVATNIHO GitHub repa
// Vyzaduje env promenne (Cloudflare Pages > Settings > Environment variables):
//   PAYHIP_API_KEY  - Payhip Settings > Developer > API key
//   PAYHIP_PRODUCT  - product link produktu (mquCD)
//   GH_TOKEN        - GitHub fine-grained token (read-only Contents na private repo)
//   GH_REPO         - "jetamdadak01-cell/pitwise-files-private"

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
  if (!env.PAYHIP_API_KEY || !env.GH_TOKEN || !env.GH_REPO) return json({ ok: false, error: "endpoint not configured" }, 500);

  // 1) overeni licencniho klice u Payhipu. 403 JEN kdyz Payhip klic opravdu odmitne (4xx / enabled=false);
  //    Payhip nedostupny (5xx, 429, sit) = 503 - klient by jinak hlasil "neplatny licencni klic" (FR 11.10.2026).
  //    Klic z e-mailu casto prijde s mezerou / neviditelnym znakem uprostred nebo malymi pismeny -> 2. pokus normalizovany.
  const product = env.PAYHIP_PRODUCT || "mquCD";
  const verify = async (k) => {
    try {
      const v = await fetch(
        "https://payhip.com/api/v1/license/verify?product_link=" + encodeURIComponent(product) + "&license_key=" + encodeURIComponent(k),
        { headers: { "payhip-api-key": env.PAYHIP_API_KEY } }
      );
      if (v.ok) {
        const j = await v.json().catch(() => null);
        return j && j.data && j.data.enabled ? "valid" : "invalid";
      }
      return v.status >= 500 || v.status === 429 ? "down" : "invalid";
    } catch (e) {
      return "down";
    }
  };
  let res = await verify(key);
  const norm = key.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "").toUpperCase();
  if (res !== "valid" && norm && norm !== key) {
    const r2 = await verify(norm);
    if (r2 === "valid" || res === "invalid") res = r2;
  }
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
