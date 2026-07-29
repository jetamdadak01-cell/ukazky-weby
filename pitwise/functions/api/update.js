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

  // 1) overeni licencniho klice u Payhipu (prazdna/chybova odpoved = neplatny)
  let valid = false;
  try {
    const product = env.PAYHIP_PRODUCT || "mquCD";
    const v = await fetch(
      "https://payhip.com/api/v1/license/verify?product_link=" + encodeURIComponent(product) + "&license_key=" + encodeURIComponent(key),
      { headers: { "payhip-api-key": env.PAYHIP_API_KEY } }
    );
    if (v.ok) {
      const j = await v.json().catch(() => null);
      valid = !!(j && j.data && j.data.enabled);
    }
  } catch (e) {}
  if (!valid) return json({ ok: false, error: "invalid license key" }, 403);

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
