const MAX_AUDIO_S = 30;
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove("hidden");
const hide = id => $(id).classList.add("hidden");
const fmt = ts => new Date(ts).toLocaleString("fr-FR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});

let auth = null;       // {token, role}
let openConv = null;   // id de la discussion ouverte (côté admin)
let timer = null;
let lastSig = "";
const mediaCache = new Map(); // fichiers déjà téléchargés (audio, image, vidéo)

/* ---------- API ---------- */
async function api(path, opts = {}){
  let res;
  try{
    res = await fetch("/api/" + path, {
      method: opts.method || "GET",
      headers: Object.assign({"Content-Type":"application/json"}, auth ? {Authorization:"Bearer "+auth.token} : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  }catch(e){ throw new Error("Connexion impossible. Vérifiez votre réseau."); }
  let data = {}; try{ data = await res.json(); }catch(e){}
  if(res.status === 401 && auth){ logout(); throw new Error("Session expirée, reconnectez-vous."); }
  if(!res.ok){ const err = new Error(data.error || "Erreur "+res.status); err.status = res.status; err.setup = !!data.setup; throw err; }
  return data;
}

/* ---------- Vues / session ---------- */
function setView(v){
  ["login","adminView","chat"].forEach(hide);
  show(v);
  clearInterval(timer); timer = null;
  if(v === "adminView"){ loadDash(); timer = setInterval(loadDash, 4000); }
  if(v === "chat"){
    lastSig = ""; loadMsgs(true); timer = setInterval(()=>loadMsgs(false), 1200);
    $("clearBtn").classList.toggle("hidden", auth.role !== "admin");
  }
}
function saveAuth(){ try{ sessionStorage.setItem("auth", JSON.stringify(auth)); }catch(e){} }
function logout(){
  auth = null; openConv = null; mediaCache.clear();
  try{ sessionStorage.removeItem("auth"); }catch(e){}
  $("codeInput").value = ""; $("loginErr").textContent = "";
  showLogin();
}
function start(){
  if(!auth) return showLogin();
  if(auth.role === "admin"){ show("backBtn"); openConv = null; setView("adminView"); }
  else { hide("backBtn"); setView("chat"); }
}

async function showLogin(){
  setView("login");
  try{
    const s = await api("status");
    const setup = !s.configured;
    $("setupForm").classList.toggle("hidden", !setup); $("setupForm").classList.toggle("flex", setup);
    $("loginForm").classList.toggle("hidden", setup);  $("loginForm").classList.toggle("flex", !setup);
    (setup ? $("setupCode") : $("codeInput")).focus();
  }catch(e){ $("loginErr").textContent = e.message; }
}

async function login(ev){
  ev.preventDefault();
  const code = $("codeInput").value.trim();
  if(!code){ $("loginErr").textContent = "Entrez votre code."; return; }
  $("loginErr").textContent = ""; $("loginBtn").disabled = true;
  try{
    const r = await api("login", {method:"POST", body:{code}});
    auth = {token:r.token, role:r.role}; saveAuth(); $("codeInput").value = ""; start();
  }catch(e){
    if(e.setup) return showLogin();
    $("loginErr").textContent = e.message;
  }
  $("loginBtn").disabled = false;
}

async function setup(ev){
  ev.preventDefault();
  const code = $("setupCode").value.trim();
  $("setupErr").textContent = "";
  if(code.length < 10){ $("setupErr").textContent = "10 caractères minimum."; return; }
  $("setupBtn").disabled = true;
  try{
    const r = await api("setup", {method:"POST", body:{code}});
    auth = {token:r.token, role:"admin"}; saveAuth(); $("setupCode").value = ""; start();
  }catch(e){ $("setupErr").textContent = e.message; if(e.status === 403) showLogin(); }
  $("setupBtn").disabled = false;
}

function strongCode(len = 20){
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ","abcdefghijkmnopqrstuvwxyz","23456789","!@#$%&*?+=-_"];
  const all = sets.join("");
  const rnd = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const out = sets.map(s => s[rnd(s.length)]);
  while(out.length < len) out.push(all[rnd(all.length)]);
  for(let i = out.length-1; i > 0; i--){ const j = rnd(i+1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join("");
}

/* ---------- Dashboard ---------- */
async function loadDash(){
  try{
    const {users, max} = await api("admin/users");
    $("nbUsers").textContent = users.length;
    const list = $("list"); list.innerHTML = "";
    if(!users.length){
      const e = document.createElement("div"); e.className = "p-3 text-center text-slate-400"; e.textContent = "Aucune discussion pour le moment."; list.appendChild(e); return;
    }
    users.forEach(u => {
      const el = document.createElement("div");
      el.className = "flex cursor-pointer items-center gap-3 rounded-xl border border-slate-700 p-3 hover:bg-slate-700/60";
      const info = document.createElement("div"); info.className = "min-w-0 flex-1";
      const n = document.createElement("div"); n.className = "font-semibold text-white"; n.textContent = u.name;
      const s = document.createElement("div"); s.className = "truncate text-sm text-slate-400";
      s.textContent = u.last
        ? (u.last.type === "audio" ? "🎤 Message vocal" : u.last.type === "image" ? "🖼️ Image" : u.last.type === "video" ? "🎬 Vidéo" : u.last.text)
        : "Aucun message";
      info.append(n, s);
      const c = document.createElement("span"); c.className = "whitespace-nowrap text-sm text-slate-400"; c.textContent = u.count + "/" + max;
      const d = document.createElement("button"); d.className = "rounded-xl bg-red-500 px-3 py-2 text-white hover:bg-red-400"; d.textContent = "🗑"; d.title = "Supprimer";
      d.onclick = async e => {
        e.stopPropagation();
        if(!confirm("Supprimer définitivement la discussion avec " + u.name + " ?")) return;
        try{ await api("admin/users/" + u.id, {method:"DELETE"}); loadDash(); }catch(err){ alert(err.message); }
      };
      el.append(info, c, d);
      el.onclick = () => { openConv = u.id; $("chatTitle").textContent = "Discussion avec " + u.name; setView("chat"); };
      list.appendChild(el);
    });
  }catch(e){ if(auth) $("createErr").textContent = e.message; }
}

async function createUser(){
  $("createErr").textContent = "";
  const name = $("newName").value.trim();
  if(!name){ $("createErr").textContent = "Entrez un nom."; return; }
  $("createBtn").disabled = true;
  try{
    const r = await api("admin/users", {method:"POST", body:{name}});
    $("newName").value = "";
    $("mName").textContent = r.name; $("mCode").textContent = r.code; show("modal");
    loadDash();
  }catch(e){ $("createErr").textContent = e.message; }
  $("createBtn").disabled = false;
}

async function changePwd(){
  const m = $("pwdMsg"); m.textContent = ""; m.className = "min-h-[1.25rem] text-sm";
  $("pwdBtn").disabled = true;
  try{
    const r = await api("admin/password", {method:"POST", body:{current:$("pwdCur").value, next:$("pwdNew").value}});
    auth.token = r.token; saveAuth();
    $("pwdCur").value = ""; $("pwdNew").value = "";
    m.textContent = "✅ Code admin modifié."; m.className = "min-h-[1.25rem] text-sm text-emerald-400";
  }catch(e){ m.textContent = e.message; m.className = "min-h-[1.25rem] text-sm text-red-400"; }
  $("pwdBtn").disabled = false;
}

/* ---------- Discussion ---------- */
const q = () => auth.role === "admin" ? "?conv=" + encodeURIComponent(openConv) : "";

async function loadMsgs(force){
  if(!auth) return;
  try{
    const r = await api("messages" + q());
    $("chatTitle").textContent = auth.role === "admin" ? "Discussion avec " + r.name : "Discussion avec l'admin";
    const m = r.messages;
    const sig = m.length + ":" + (m[m.length-1]?.id || "");
    if(!force && sig === lastSig) return;
    lastSig = sig;
    render(m, r.max);
  }catch(e){
    if(auth && /n'existe plus/.test(e.message)){ alert(e.message); auth.role === "admin" ? start() : logout(); }
  }
}

function render(msgs, max){
  const box = $("msgs"); box.innerHTML = "";
  if(!msgs.length){
    const d = document.createElement("div"); d.className = "self-center rounded-full bg-slate-800 px-3 py-1.5 text-center text-sm text-slate-400";
    d.textContent = "Aucun message. Écrivez le premier !"; box.appendChild(d);
  }
  msgs.forEach(m => {
    if(m.from === "system"){
      const d = document.createElement("div"); d.className = "self-center rounded-full bg-slate-800 px-3 py-1.5 text-center text-sm text-slate-400";
      d.textContent = m.text; box.appendChild(d); return;
    }
    const mine = m.from === auth.role;   // mes messages à droite, ceux de l'autre à gauche
    const el = document.createElement("div");
    el.className = mine
      ? "max-w-[78%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-indigo-600 px-3.5 py-2 text-white"
      : "max-w-[78%] self-start whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-slate-700 px-3.5 py-2 text-slate-100";
    el.dataset.side = mine ? "right" : "left";
    if(m.type === "audio" || m.type === "image" || m.type === "video"){
      const tag = m.type === "audio" ? "audio" : m.type === "image" ? "img" : "video";
      const node = document.createElement(tag);
      node.className = m.type === "audio" ? "h-9 max-w-full" : "max-w-full rounded-lg";
      if(m.type !== "image") node.controls = true;
      if(m.type === "image") node.alt = "Image envoyée";
      el.appendChild(node);
      if(mediaCache.has(m.id)) node.src = mediaCache.get(m.id);
      else api("media" + (auth.role === "admin" ? q() + "&id=" + m.id : "?id=" + m.id))
        .then(r => { mediaCache.set(m.id, r.data); node.src = r.data; }).catch(() => {});
    } else el.appendChild(document.createTextNode(m.text));
    const t = document.createElement("small"); t.className = "mt-1 block text-right text-[11px] opacity-70"; t.textContent = fmt(m.ts);
    el.appendChild(t);
    box.appendChild(el);
  });
  const n = msgs.filter(m => m.from !== "system").length;
  $("counter").textContent = n + "/" + max;
  $("counter").className = "whitespace-nowrap text-sm " + (n >= max - 10 ? "text-amber-400" : "text-slate-400");
  box.scrollTop = box.scrollHeight;
}

async function post(payload){
  $("sendBtn").disabled = true;
  try{ await api("messages" + q(), {method:"POST", body:payload}); await loadMsgs(true); }
  catch(e){ alert(e.message); }
  $("sendBtn").disabled = false;
}
function sendText(){
  const v = $("msgInput").value.trim(); if(!v) return;
  $("msgInput").value = ""; post({type:"text", text:v});
}

/* ---------- Audio ---------- */
let recorder, chunks = [], recTimer;
async function toggleRec(){
  if(recorder && recorder.state === "recording"){ recorder.stop(); return; }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    recorder = new MediaRecorder(stream); chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = () => {
      clearTimeout(recTimer); stream.getTracks().forEach(t => t.stop());
      $("rec").classList.remove("bg-red-500","animate-pulse","border-red-500"); $("rec").textContent = "🎤";
      const blob = new Blob(chunks, {type: recorder.mimeType || "audio/webm"});
      const r = new FileReader();
      r.onload = () => post({type:"audio", audio:r.result});
      r.readAsDataURL(blob);
    };
    recorder.start();
    $("rec").classList.add("bg-red-500","animate-pulse","border-red-500"); $("rec").textContent = "⏹";
    recTimer = setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_AUDIO_S * 1000);
  }catch(e){ alert("Micro inaccessible : autorisez-le dans le navigateur."); }
}

/* ---------- Image / vidéo ---------- */
const MAX_IMAGE_MB = 3.5, MAX_VIDEO_MB = 5.5;
async function pickMedia(){
  const f = $("mediaInput").files[0]; $("mediaInput").value = "";
  if(!f) return;
  const isImg = f.type.startsWith("image/"), isVid = f.type.startsWith("video/");
  if(!isImg && !isVid){ alert("Seules les images et les vidéos sont acceptées."); return; }
  const maxMB = isImg ? MAX_IMAGE_MB : MAX_VIDEO_MB;
  if(f.size > maxMB * 1024 * 1024){
    alert(`Fichier trop lourd (${maxMB} Mo maximum).` + (isVid ? " Gardez vos vidéos très courtes (quelques secondes)." : ""));
    return;
  }
  const r = new FileReader();
  r.onload = () => post({ type: isImg ? "image" : "video", media: r.result });
  r.readAsDataURL(f);
}

/* ---------- Vider une discussion (admin) ---------- */
async function clearChat(){
  if(!confirm("Vider cette discussion ? Tous les messages et fichiers seront supprimés définitivement. Le code de la personne restera valide, elle pourra continuer à écrire.")) return;
  try{ await api("admin/clear/" + openConv, {method:"POST"}); await loadMsgs(true); }
  catch(e){ alert(e.message); }
}

/* ---------- Événements ---------- */
$("loginForm").addEventListener("submit", login);
$("setupForm").addEventListener("submit", setup);
$("eyeBtn").onclick = () => { const i = $("codeInput"); i.type = i.type === "text" ? "password" : "text"; i.focus(); };
$("genBtn").onclick = () => { $("setupCode").value = strongCode(); $("setupErr").textContent = "Copiez ce code dans un endroit sûr avant de valider."; };
$("createBtn").onclick = createUser;
$("newName").addEventListener("keydown", e => { if(e.key === "Enter") createUser(); });
$("pwdBtn").onclick = changePwd;
$("logout1").onclick = logout; $("logout2").onclick = logout;
$("backBtn").onclick = () => { openConv = null; lastSig = ""; setView("adminView"); };
$("sendBtn").onclick = sendText;
$("msgInput").addEventListener("keydown", e => { if(e.key === "Enter") sendText(); });
$("rec").onclick = toggleRec;
$("mediaBtn").onclick = () => $("mediaInput").click();
$("mediaInput").onchange = pickMedia;
$("clearBtn").onclick = clearChat;
$("mClose").onclick = () => { hide("modal"); $("mCode").textContent = ""; };
$("copyBtn").onclick = async () => {
  try{ await navigator.clipboard.writeText($("mCode").textContent); $("copyBtn").textContent = "Copié ✓"; }
  catch(e){ alert("Sélectionnez le code et copiez-le manuellement."); }
  setTimeout(() => $("copyBtn").textContent = "Copier", 1500);
};

// Flou cosmétique quand la fenêtre perd le focus (ne bloque pas les captures, voir styles.css)
function updatePrivacyBlur(){ document.body.classList.toggle("privacy-blur", document.hidden || !document.hasFocus()); }
document.addEventListener("visibilitychange", updatePrivacyBlur);
window.addEventListener("blur", updatePrivacyBlur);
window.addEventListener("focus", updatePrivacyBlur);

try{ auth = JSON.parse(sessionStorage.getItem("auth")); }catch(e){ auth = null; }
start();
