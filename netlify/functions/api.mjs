import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/* =====================================================================
   AUCUNE variable d'environnement n'est nécessaire.
   - Le secret de signature est généré automatiquement au premier appel
     et stocké dans Netlify Blobs (clé "secret").
   - Le code admin est choisi par toi au premier lancement du site
     (écran de configuration) et stocké HACHÉ (scrypt) (clé "admin").
   Ces données survivent à tous les redéploiements / mises à jour.
   ===================================================================== */

const MAX_MESSAGES = 100;
const TOKEN_TTL = 12 * 3600 * 1000;      // session : 12 h
const MAX_TEXT = 2000;
const MAX_AUDIO_CHARS = 1_500_000;       // ~1 Mo en base64 (≈ 30 s de vocal)
const MIN_ADMIN_CODE = 10;

export const config = { path: "/api/*" };

/* ============ Utilitaires ============ */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const mac = (secret, s) => crypto.createHmac("sha256", secret).update(s).digest();
const scrypt = (pw, salt) =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => (e ? rej(e) : res(k))));
const isId = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
const readBody = async (req) => { try { return await req.json(); } catch { return {}; } };

// Identifiant de discussion = empreinte secrète du code (le code n'est JAMAIS stocké)
const convId = (secret, code) => mac(secret, "conv:" + code).toString("hex").slice(0, 32);

function signToken(secret, payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return b + "." + mac(secret, "tok:" + b).toString("base64url");
}
function readToken(secret, req) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [b, sig] = t.split(".");
  if (!b || !sig) return null;
  const good = mac(secret, "tok:" + b);
  let given;
  try { given = Buffer.from(sig, "base64url"); } catch { return null; }
  if (given.length !== good.length || !crypto.timingSafeEqual(given, good)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// Code utilisateur : majuscules + minuscules + chiffres + caractères spéciaux (16 caractères)
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

async function makeAdmin(code, ver) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(code, salt);
  return { salt: salt.toString("hex"), hash: hash.toString("hex"), ver };
}
async function checkAdmin(code, admin) {
  const k = await scrypt(code, Buffer.from(admin.salt, "hex"));
  const good = Buffer.from(admin.hash, "hex");
  return k.length === good.length && crypto.timingSafeEqual(k, good);
}

// Anti force-brute : 8 échecs max par IP sur 15 minutes
async function guard(store, req, context) {
  const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const key = "fail/" + sha(ip).slice(0, 24);
  const f = (await store.get(key, { type: "json" })) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
  return {
    blocked: f.n >= 8,
    fail: async () => { f.n += 1; await store.setJSON(key, f); await new Promise((r) => setTimeout(r, 500)); },
    ok: async () => { if (f.n) await store.delete(key); },
  };
}

async function wipe(store, id) {
  await store.setJSON("msgs/" + id, []);
  const { blobs } = await store.list({ prefix: "audio/" + id + "/" });
  await Promise.all(blobs.map((b) => store.delete(b.key)));
}

/* ============ Handler ============ */
export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error("API error:", e);
    return json({ error: "Erreur serveur. Réessayez." }, 500);
  }
};

async function handle(req, context) {
  const store = getStore({ name: "chat", consistency: "strong" });
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const parts = route.split("/");
  const method = req.method;

  const [secretRec, admin] = await Promise.all([
    store.get("secret", { type: "json" }),
    store.get("admin", { type: "json" }),
  ]);

  /* ---------- Le site est-il déjà configuré ? ---------- */
  if (route === "status" && method === "GET") return json({ configured: !!admin });

  /* ---------- Première configuration : choix du code admin ---------- */
  if (route === "setup" && method === "POST") {
    if (admin) return json({ error: "Le site est déjà configuré." }, 403);
    const { code } = await readBody(req);
    const c = typeof code === "string" ? code.trim() : "";
    if (c.length < MIN_ADMIN_CODE || c.length > 100)
      return json({ error: `Le code admin doit contenir entre ${MIN_ADMIN_CODE} et 100 caractères.` }, 400);
    let sec = secretRec;
    if (!sec) { sec = { key: crypto.randomBytes(32).toString("hex") }; await store.setJSON("secret", sec); }
    const a = await makeAdmin(c, 1);
    await store.setJSON("admin", a);
    const token = signToken(Buffer.from(sec.key, "hex"), { role: "admin", av: 1, exp: Date.now() + TOKEN_TTL });
    return json({ token, role: "admin" });
  }

  if (!admin || !secretRec) return json({ error: "Le site n'est pas encore configuré.", setup: true }, 409);
  const secret = Buffer.from(secretRec.key, "hex");

  /* ---------- LOGIN ---------- */
  if (route === "login" && method === "POST") {
    const g = await guard(store, req, context);
    if (g.blocked) return json({ error: "Trop de tentatives. Réessayez dans 15 minutes." }, 429);

    const { code } = await readBody(req);
    const c = typeof code === "string" ? code.trim() : "";
    if (!c || c.length > 100) return json({ error: "Code invalide." }, 400);

    if (await checkAdmin(c, admin)) {
      await g.ok();
      return json({ token: signToken(secret, { role: "admin", av: admin.ver, exp: Date.now() + TOKEN_TTL }), role: "admin" });
    }
    const id = convId(secret, c);
    const conv = await store.get("conv/" + id, { type: "json" });
    if (!conv) { await g.fail(); return json({ error: "Code invalide." }, 401); }
    await g.ok();
    return json({ token: signToken(secret, { role: "user", conv: id, exp: Date.now() + TOKEN_TTL }), role: "user", name: conv.name });
  }

  /* ---------- Tout le reste nécessite une session valide ---------- */
  const me = readToken(secret, req);
  if (!me) return json({ error: "Non autorisé." }, 401);
  if (me.role === "admin" && me.av !== admin.ver) return json({ error: "Session expirée." }, 401);

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
        const real = msgs.filter((m) => m.from !== "system");
        const last = real[real.length - 1];
        out.push({ id, name: conv.name, created: conv.created, count: msgs.length,
          last: last ? { type: last.type, text: last.text, from: last.from } : null });
      }
      out.sort((a, b) => b.created - a.created);
      return json({ users: out, max: MAX_MESSAGES });
    }

    // Créer une discussion : le serveur génère le code (affiché UNE seule fois)
    if (parts[1] === "users" && method === "POST") {
      const { name } = await readBody(req);
      const n = typeof name === "string" ? name.trim().slice(0, 40) : "";
      if (!n) return json({ error: "Nom requis." }, 400);
      let code, id;
      do { code = genCode(); id = convId(secret, code); } while (await store.get("conv/" + id));
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

    // Changer le code admin
    if (parts[1] === "password" && method === "POST") {
      const g = await guard(store, req, context);
      if (g.blocked) return json({ error: "Trop de tentatives. Réessayez dans 15 minutes." }, 429);
      const { current, next } = await readBody(req);
      if (typeof current !== "string" || !(await checkAdmin(current.trim(), admin))) {
        await g.fail(); return json({ error: "Code actuel incorrect." }, 403);
      }
      const nx = typeof next === "string" ? next.trim() : "";
      if (nx.length < MIN_ADMIN_CODE || nx.length > 100)
        return json({ error: `Le nouveau code doit contenir entre ${MIN_ADMIN_CODE} et 100 caractères.` }, 400);
      await g.ok();
      const a = await makeAdmin(nx, (admin.ver || 1) + 1);
      await store.setJSON("admin", a);
      const token = signToken(secret, { role: "admin", av: a.ver, exp: Date.now() + TOKEN_TTL });
      return json({ ok: true, token });
    }
    return json({ error: "Route inconnue." }, 404);
  }

  /* ---------- Résolution de la discussion (admin: ?conv=, user: son jeton) ---------- */
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
    const b = await readBody(req);
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

    // Sécurité : à 100 messages, toute la discussion (messages + audios) est effacée
    if (msgs.filter((m) => m.from !== "system").length >= MAX_MESSAGES) {
      await wipe(store, id);
      msgs = [{ id: "sys" + Date.now().toString(36), from: "system", type: "text", ts: Date.now(),
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
}
