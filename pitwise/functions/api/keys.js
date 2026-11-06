// Cloudflare Pages Function — casove omezene licencni klice (PWT-...), spravuje je admin panel; overuje /api/update.
//   GET  /api/keys?token=ADMIN_TOKEN                 -> { ok, items: [{ key, exp, note, created }] }
//   POST /api/keys?token=ADMIN_TOKEN  { exp, note }  -> novy klic
//   PUT  /api/keys?token=ADMIN_TOKEN  { key, exp }   -> zmena expirace (exp v minulosti = vypnuti)
// exp = ms od epochy. Vyzaduje: KV "FEEDBACK" + env ADMIN_TOKEN.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 32 znaku bez I/O -> & 31 je rovnomerne, 15 znaku = 75 bitu

export async function onRequest({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  const token = new URL(request.url).searchParams.get("token") || "";
  if (!env.ADMIN_TOKEN || !safeEq(token, String(env.ADMIN_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);
  const kv = env.FEEDBACK;
  if (!kv) return json({ ok: false, error: "KV not configured" }, 500);

  if (request.method === "GET") {
    const items = [];
    let cursor;
    do {
      const page = await kv.list({ prefix: "tkey_", cursor });
      for (const k of page.keys) items.push({ key: k.name.slice(5), ...k.metadata });
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    items.sort((a, b) => (b.created || 0) - (a.created || 0));
    return json({ ok: true, items });
  }

  if (request.method !== "POST" && request.method !== "PUT") return json({ ok: false, error: "method" }, 405);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const exp = body && body.exp;
  if (!Number.isSafeInteger(exp) || exp <= 0) return json({ ok: false, error: "bad exp" }, 400);

  let key, rec;
  if (request.method === "POST") {
    if (exp <= Date.now()) return json({ ok: false, error: "expiry is in the past" }, 400);
    const chars = Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => ALPHABET[b & 31]).join("");
    key = "PWT-" + chars.slice(0, 5) + "-" + chars.slice(5, 10) + "-" + chars.slice(10);
    rec = { exp, note: String(body.note || "").slice(0, 200), created: Date.now() };   // metadata KV unese max 1 KB
  } else {
    key = String(body.key || "");
    const old = await kv.get("tkey_" + key);
    if (!key.startsWith("PWT-") || !old) return json({ ok: false, error: "unknown key" }, 404);
    rec = { ...JSON.parse(old), exp };
  }
  await kv.put("tkey_" + key, JSON.stringify(rec), { metadata: rec });
  return json({ ok: true, key, ...rec });
}

function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
