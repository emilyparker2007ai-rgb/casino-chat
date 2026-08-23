"use strict";
// Bot 463: crea el jugador en el panel admin (admin.463.life) y escribe usuario/clave en el lead de Kommo.
// Credenciales SOLO por variables de entorno. Convencion del casino: usuario = nombre + 4 digitos, clave = esos 4 digitos.

const ADMIN_URL = process.env.CASINO_ADMIN_URL || "https://admin.463.life";
const ADMIN_USER = process.env.CASINO_ADMIN_USER || "";
const ADMIN_PASS = process.env.CASINO_ADMIN_PASS || "";
const AGENT_ID = process.env.CASINO_AGENT_ID || "9874458";
const PLAY_URL = process.env.PLAY_URL || "https://ganandoen463.site/";

// ---------- sesion del panel ----------
let cookie = "";
function pickCookies(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const parts = raw.filter(Boolean).map((c) => c.split(";")[0]);
  if (parts.length) cookie = parts.join("; ");
}
async function adminLogin() {
  if (!ADMIN_USER || !ADMIN_PASS) throw new Error("faltan CASINO_ADMIN_USER/PASS");
  const r0 = await fetch(ADMIN_URL + "/index.php?act=admin&area=login", { redirect: "manual" });
  pickCookies(r0);
  const body = new URLSearchParams({ login: ADMIN_USER, password: ADMIN_PASS });
  const r1 = await fetch(ADMIN_URL + "/index.php?act=admin&area=login", {
    method: "POST", redirect: "manual", body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
  });
  pickCookies(r1);
  const r2 = await fetch(ADMIN_URL + "/index.php?act=admin", { headers: { Cookie: cookie }, redirect: "manual" });
  const html = await r2.text();
  if (!/area=logout/.test(html)) throw new Error("login al panel fallo");
  return true;
}
function stripTags(s) { return String(s).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }

async function postCreate(fields) {
  const body = new URLSearchParams({ group: "5", name: fields.name, login: fields.login, password: fields.password, balance: "", sended: "true" });
  const r = await fetch(ADMIN_URL + "/index.php?act=admin&area=createuser&id=" + AGENT_ID, {
    method: "POST", body, redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", Cookie: cookie },
  });
  return r.text();
}

// Crea el jugador. Devuelve {ok, id} o {ok:false, error, loginTaken}
async function createPlayer({ name, login, password }) {
  if (!cookie) await adminLogin();
  let html = await postCreate({ name, login, password });
  if (/name="password"[^>]*type="password"|area=login/.test(html) && !/Success/.test(html)) { // sesion vencida
    await adminLogin();
    html = await postCreate({ name, login, password });
  }
  const text = stripTags(html);
  const m = html.match(/user-result-buttons[^>]*id="(\d+)"/);
  if (/Success/i.test(text) && m) return { ok: true, id: m[1] };
  const err = text.slice(0, 200) || "error desconocido";
  return { ok: false, error: err, loginTaken: /exist|ya existe|taken|occupied|busy|ocupad|duplicad/i.test(err) };
}

// ---------- generacion de usuario ----------
function baseFromName(name) {
  const base = String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .split(/\s+/).filter(Boolean)[0] || "";
  const clean = base.replace(/[^a-z]/g, "").slice(0, 10);
  return clean.length >= 3 ? clean : "user";
}
function fourDigits() { return String(1000 + Math.floor(Math.random() * 9000)); }
function makeCredentials(name) { const d = fourDigits(); return { login: baseFromName(name) + d, password: d }; }

// Intenta hasta 4 logins distintos si el usuario ya existe
async function createForName(name) {
  let last = null;
  for (let i = 0; i < 4; i++) {
    const c = makeCredentials(name);
    const r = await createPlayer({ name: String(name).slice(0, 60), login: c.login, password: c.password });
    if (r.ok) return { ok: true, id: r.id, login: c.login, password: c.password };
    last = r; if (!r.loginTaken) break;
  }
  return { ok: false, error: (last && last.error) || "no se pudo crear" };
}

// ---------- texto de respuesta (sin emojis: la plataforma los rompe) ----------
function accessMessage(name, login, password) {
  const n = String(name || "").trim().split(/\s+/)[0];
  return `Hola ${n}! Listo, estos son tus datos de acceso:\nUsuario: ${login}\nClave: ${password}\nLINK DE LA PLATAFORMA: ${PLAY_URL}\n\nQueres el CBU para hacer tu primer deposito? Recorda que la primera carga tiene 200% extra.`;
}

module.exports = { adminLogin, createPlayer, createForName, makeCredentials, baseFromName, accessMessage, PLAY_URL };
