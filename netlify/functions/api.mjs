import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/* ============ CONFIG (variables d'environnement Netlify) ============ */
const SECRET = process.env.SECRET;          // longue chaîne aléatoire (signe les sessions + hash les codes)
const ADMIN_CODE = process.env.ADMIN_CODE;  // TON code admin (jamais écrit dans le site)
const MAX_MESSAGES = 100;
const TOKEN_TTL = 12 * 3600 * 1000;         // session : 12 h
const MAX_TEXT = 2000;
const MAX_AUDIO_CHARS = 1_500_000;          // ~1 Mo en base64 (≈ 30 s de vocal)

export const config = { path: "/api/*" };

/* ============ Utilitaires ============ */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest();
// Identifiant de discussion = empreinte secrète du code (le code lui-même n'est JAMAIS stocké)
const convId = (code) => hmac("conv:" + code).toString("hex").slice(0, 32);
const safeEq = (a, b) => crypto.timingSafeEqual(hmac("cmp:" + a), hmac("cmp:" + b));
const isId = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);

function signToken(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return b + "." + hmac("tok:" + b).toString("base64url");
}
function readToken(req) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [b, sig] = t.split(".");
  if (!b || !sig) return null;
  const good = hmac("tok:" + b);
  let given;
  try { given = Buffer.from(sig, "base64url"); } catch { return null; }
  if (given.length !== good.length || !crypto.timingSafeEqual(given, good)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// Code : majuscules + minuscules + chiffres + caractères spéciaux (16 caractères)
function genCode(len = 16) {
  const U = "ABCDEFGHJKLMNPQRSTUVWXYZ", L = "abcdefghijkmnopqrstuvwxyz", D = "23456789", S = "!@#$%&*?+=-_";
  const pick = (s) => s[crypto.randomInt(s.length)];
  const all = U + L + D + S;
  const arr = [pick(U), pick(L), pick(D), pick(S)];
  while (arr.length < len) arr.push(pick(all));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

/* ============ Handler ============ */
export default async (req, context) => {
  if (!SECRET || !ADMIN_CODE) return json({ error: "Serveur non configuré (variables SECRET / ADMIN_CODE manquantes)." }, 500);

  const store = getStore("chat");
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const parts = route.split("/");
  const method = req.method;

  /* ---------- LOGIN (avec limitation anti force-brute) ---------- */
  if (route === "login" && method === "POST") {
    const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "unknown";
    const failKey = "fail/" + crypto.createHash("sha256").update(ip).digest("hex").slice(0, 24);
    const f = (await store.get(failKey, { type: "json" })) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 15 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 8) return json({ error: "Trop de tentatives. Réessayez dans 15 minutes." }, 429);

    const { code } = await body(req);
    const c = typeof code === "string" ? code.trim() : "";
    if (!c || c.length > 100) return json({ error: "Code invalide." }, 400);

    if (safeEq(c, ADMIN_CODE)) {
      await store.delete(failKey);
      return json({ token: signToken({ role: "admin", exp: Date.now() + TOKEN_TTL }), role: "admin" });
    }
    const id = convId(c);
    const conv = await store.get("conv/" + id, { type: "json" });
    if (!conv) {
      f.n += 1; await store.setJSON(failKey, f);
      await new Promise((r) => setTimeout(r, 600));
      return json({ error: "Code invalide." }, 401);
    }
    await store.delete(failKey);
    return json({ token: signToken({ role: "user", conv: id, exp: Date.now() + TOKEN_TTL }), role: "user", name: conv.name });
  }

  /* ---------- Tout le reste nécessite une session ---------- */
  const me = readToken(req);
  if (!me) return json({ error: "Non autorisé." }, 401);

  /* ---------- ADMIN ---------- */
  if (parts[0] === "admin") {
    if (me.role !== "admin") return json({ error: "Interdit." }, 403);

    // Liste des discussions
    if (parts[1] === "users" && method === "GET" && !parts[2]) {
      const { blobs } = await store.list({ prefix: "conv/" });
      const out = [];
      for (const b of blobs) {
        const id = b.key.slice(5);
        const conv = await store.get(b.key, { type: "json" });
        if (!conv) continue;
        const msgs = (await store.get("msgs/" + id, { type: "json" })) || [];
        const last = msgs[msgs.length - 1];
        out.push({ id, name: conv.name, created: conv.created, count: msgs.length,
          last: last ? { type: last.type, text: last.text, from: last.from } : null });
      }
      out.sort((a, b) => b.created - a.created);
      return json({ users: out, max: MAX_MESSAGES });
    }

    // Créer une discussion : le serveur génère le code (affiché UNE seule fois)
    if (parts[1] === "users" && method === "POST") {
      const { name } = await body(req);
      const n = typeof name === "string" ? name.trim().slice(0, 40) : "";
      if (!n) return json({ error: "Nom requis." }, 400);
      let code, id;
      do { code = genCode(); id = convId(code); } while (await store.get("conv/" + id) || safeEq(code, ADMIN_CODE));
      await store.setJSON("conv/" + id, { name: n, created: Date.now() });
      await store.setJSON("msgs/" + id, []);
      return json({ id, name: n, code });
    }

    // Supprimer une discussion
    if (parts[1] === "users" && method === "DELETE" && isId(parts[2])) {
      await wipe(store, parts[2]);
      await store.delete("conv/" + parts[2]);
      await store.delete("msgs/" + parts[2]);
      return json({ ok: true });
    }
    return json({ error: "Route inconnue." }, 404);
  }

  /* ---------- Résolution de la discussion (admin: ?conv=, user: son token) ---------- */
  const id = me.role === "admin" ? url.searchParams.get("conv") : me.conv;
  if (!isId(id)) return json({ error: "Discussion invalide." }, 400);
  const conv = await store.get("conv/" + id, { type: "json" });
  if (!conv) return json({ error: "Cette discussion n'existe plus." }, 404);

  /* ---------- MESSAGES ---------- */
  if (route === "messages" && method === "GET") {
    const msgs = (await store.get("msgs/" + id, { type: "json" })) || [];
    return json({ name: conv.name, messages: msgs, max: MAX_MESSAGES });
  }

  if (route === "messages" && method === "POST") {
    const b = await body(req);
    let msgs = (await store.get("msgs/" + id, { type: "json" })) || [];
    const msg = { id: Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), from: me.role, ts: Date.now() };

    if (b.type === "audio") {
      if (typeof b.audio !== "string" || !b.audio.startsWith("data:audio/") || b.audio.length > MAX_AUDIO_CHARS)
        return json({ error: "Audio invalide ou trop long." }, 400);
      msg.type = "audio";
    } else {
      const t = typeof b.text === "string" ? b.text.trim() : "";
      if (!t || t.length > MAX_TEXT) return json({ error: "Message vide ou trop long." }, 400);
      msg.type = "text"; msg.text = t;
    }

    // Sécurité : à 100 messages, toute la discussion est effacée
    if (msgs.length >= MAX_MESSAGES) {
      await wipe(store, id);
      msgs = [{ id: "sys" + Date.now(), from: "system", type: "text", ts: Date.now(),
        text: "🔒 Limite de " + MAX_MESSAGES + " messages atteinte : l'ancienne discussion a été effacée." }];
    }
    if (msg.type === "audio") await store.set("audio/" + id + "/" + msg.id, b.audio);
    msgs.push(msg);
    await store.setJSON("msgs/" + id, msgs);
    return json({ ok: true, message: msg });
  }

  /* ---------- AUDIO ---------- */
  if (route === "audio" && method === "GET") {
    const mid = url.searchParams.get("id") || "";
    if (!/^[a-z0-9]{4,40}$/.test(mid)) return json({ error: "Id invalide." }, 400);
    const data = await store.get("audio/" + id + "/" + mid);
    if (!data) return json({ error: "Introuvable." }, 404);
    return json({ data });
  }

  return json({ error: "Route inconnue." }, 404);
};

async function wipe(store, id) {
  await store.setJSON("msgs/" + id, []);
  const { blobs } = await store.list({ prefix: "audio/" + id + "/" });
  await Promise.all(blobs.map((b) => store.delete(b.key)));
}
