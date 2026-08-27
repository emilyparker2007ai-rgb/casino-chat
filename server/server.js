"use strict";
// Chat web de 2 vias (cliente <-> admin) + registro en Kommo.
// El token de Kommo y la clave de admin viven SOLO en variables de entorno del servidor.

const http = require("http");
const fs = require("fs");
const path = require("path");

const SUB = process.env.KOMMO_SUBDOMAIN || "";
const TOK = process.env.KOMMO_TOKEN || "";
const PIPELINE_ID = parseInt(process.env.KOMMO_PIPELINE_ID || "10741823", 10);
const STATUS_ID = parseInt(process.env.KOMMO_STATUS_ID || "82365651", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || "463admin";
const PORT = process.env.PORT || 3000;

function page(name) {
  try { return fs.readFileSync(path.join(__dirname, "..", name)); }
  catch (e) { return Buffer.from("<h1>" + name + " missing</h1>"); }
}
const INDEX = page("index.html");
const ADMIN = page("admin.html");
const GSAP = page("gsap.min.js");

// ---- store en memoria (Kommo es el registro durable via notas) ----
const convs = new Map(); // id -> {id,name,phone,clid,leadId,contactId,createdAt,msgs:[],adminReadSeq}
let SEQ = 1;
function conv(id) { return convs.get(String(id)); }
function pushMsg(c, from, text) {
  const m = { id: SEQ++, from: from, text: String(text).slice(0, 1000), ts: Date.now() };
  c.msgs.push(m);
  if (c.msgs.length > 500) c.msgs = c.msgs.slice(-500);
  return m;
}

// ---- rate limit ----
const hits = new Map();
function limited(ip, max) {
  const s = Math.floor(Date.now() / 1000);
  const arr = (hits.get(ip) || []).filter((t) => s - t < 60);
  arr.push(s); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > (max || 60);
}

async function kommo(pathname, method, body) {
  const res = await fetch("https://" + SUB + ".kommo.com/api/v4" + pathname, {
    method,
    headers: { Authorization: "Bearer " + TOK, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
  return { status: res.status, json: j, txt };
}
function clean(s, max) { return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max || 200); }

async function createLead(name, message, clid) {
  const payload = [{
    name: clean(name, 80) + " (chat web)",
    pipeline_id: PIPELINE_ID, status_id: STATUS_ID,
    _embedded: { contacts: [{ name: clean(name, 80) }], tags: [{ name: "chat-web" }, { name: "463" }] },
  }];
  const r = await kommo("/leads/complex", "POST", payload);
  const row = Array.isArray(r.json) ? r.json[0] : null;
  if (!row || !row.id) return { ok: false };
  await kommo("/leads/" + row.id + "/notes", "POST", [
    { note_type: "common", params: { text: "Origen anuncio: " + (clid || "(directo)") + "\nPrimer mensaje: " + clean(message, 500) } },
  ]).catch(() => {});
  return { ok: true, leadId: row.id, contactId: row.contact_id || 0 };
}
async function setPhone(contactId, phone) {
  if (!contactId) return;
  await kommo("/contacts/" + contactId, "PATCH", {
    custom_fields_values: [{ field_code: "PHONE", values: [{ value: clean(phone, 40), enum_code: "MOB" }] }],
  }).catch(() => {});
}
async function note(leadId, text) {
  if (!leadId) return;
  await kommo("/leads/" + leadId + "/notes", "POST", [{ note_type: "common", params: { text: clean(text, 900) } }]).catch(() => {});
}

// Reconstruye el panel desde Kommo (registro durable): leads con tag chat-web + sus notas.
async function loadFromKommo() {
  try {
    var tg = await kommo("/leads/tags?filter[name]=chat-web&limit=1", "GET");
    var tag = tg.json && tg.json._embedded && tg.json._embedded.tags && tg.json._embedded.tags[0];
    var url = "/leads?limit=50&order[updated_at]=desc&with=contacts";
    if (tag) url += "&filter[tags][0]=" + tag.id;
    var r = await kommo(url, "GET");
    var leads = (r.json && r.json._embedded && r.json._embedded.leads) || [];
    for (var i = 0; i < leads.length; i++) {
      var L = leads[i];
      if (L.status_id === 143) continue;               // saltar Perdido / tests
      var id = String(L.id);
      if (convs.has(id)) continue;                     // no pisar conversaciones vivas
      var contact = L._embedded && L._embedded.contacts && L._embedded.contacts[0];
      var c = { id: id, name: String(L.name || "").replace(/ \(chat web\)$/, ""), phone: "", clid: "",
        leadId: L.id, contactId: contact ? contact.id : 0, createdAt: (L.created_at || 0) * 1000 || Date.now(),
        msgs: [], adminReadSeq: 0 };
      var n = await kommo("/leads/" + L.id + "/notes?limit=100&order[created_at]=asc&filter[note_type]=common", "GET");
      var notes = (n.json && n.json._embedded && n.json._embedded.notes) || [];
      for (var k = 0; k < notes.length; k++) {
        var txt = notes[k].params && notes[k].params.text; if (!txt) continue;
        var from = null, body = txt;
        if (txt.indexOf("Cliente: ") === 0) { from = "client"; body = txt.slice(9); }
        else if (txt.indexOf("Asesor: ") === 0) { from = "admin"; body = txt.slice(8); }
        else if (txt.indexOf("Primer mensaje:") >= 0) { from = "client"; body = txt.split("Primer mensaje:")[1].trim(); }
        if (from) c.msgs.push({ id: SEQ++, from: from, text: body, ts: (notes[k].created_at || 0) * 1000 || Date.now() });
      }
      convs.set(id, c);
    }
  } catch (e) {}
}

// ---- campos personalizados del lead (por nombre, cacheados) ----
const bot = require("./bot463");
let FIELD_CACHE = null;
async function fieldIds() {
  if (FIELD_CACHE) return FIELD_CACHE;
  const r = await kommo("/leads/custom_fields?limit=250", "GET");
  const list = (r.json && r.json._embedded && r.json._embedded.custom_fields) || [];
  FIELD_CACHE = {}; list.forEach((f) => { FIELD_CACHE[f.name] = f.id; });
  return FIELD_CACHE;
}
function fieldMap(lead) {
  const out = {}; (lead.custom_fields_values || []).forEach((f) => { const v = f.values && f.values[0] && f.values[0].value; if (v != null) out[f.field_name] = String(v); });
  return out;
}
async function setFields(leadId, F, values) {
  const cfv = Object.keys(values).filter((k) => F[k]).map((k) => ({ field_id: F[k], values: [{ value: String(values[k]).slice(0, 250) }] }));
  if (!cfv.length) return;
  return kommo("/leads/" + leadId, "PATCH", { custom_fields_values: cfv });
}

function send(res, code, obj, ctype) {
  if (ctype) { res.writeHead(code, { "Content-Type": ctype }); res.end(obj); return; }
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 8000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { resolve({}); } });
  });
}
function ip(req) { return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }
function msgsAfter(c, after) { return c.msgs.filter((m) => m.id > after).map((m) => ({ id: m.id, from: m.from, text: m.text, ts: m.ts })); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const u = url.pathname;
  const q = url.searchParams;
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (u === "/health") return send(res, 200, { ok: true, convs: convs.size });

  if (req.method === "GET" && (u === "/" || u === "/index.html"))
    return send(res, 200, INDEX, "text/html; charset=utf-8");
  if (req.method === "GET" && (u === "/admin" || u === "/admin.html"))
    return send(res, 200, ADMIN, "text/html; charset=utf-8");
  // landing estatica 463 (HTML + logo webp/jpg)
  if (req.method === "GET" && (u === "/463" || u === "/463/" || u.startsWith("/463/"))) {
    const rel = (u === "/463" || u === "/463/") ? "index.html" : u.slice(5).replace(/\.\./g, "");
    const types = { ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".jpg": "image/jpeg" };
    const ext = rel.slice(rel.lastIndexOf("."));
    try {
      const buf = fs.readFileSync(path.join(__dirname, "..", "landing-463", rel));
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "public, max-age=3600" });
      return res.end(buf);
    } catch (e) { return send(res, 404, { ok: false }); }
  }

  if (req.method === "GET" && u === "/gsap.min.js")
    return send(res, 200, GSAP, "application/javascript; charset=utf-8");

  // ---------- CLIENTE ----------
  if (u === "/api/lead" && req.method === "POST") {
    if (limited(ip(req), 40)) return send(res, 429, { ok: false });
    const b = await readBody(req);
    if (b.action === "create") {
      const r = await createLead(b.name, b.message, b.clid);
      const id = r.ok ? String(r.leadId) : "tmp" + SEQ;
      const c = { id, name: clean(b.name, 80), phone: "", clid: b.clid || "", leadId: r.leadId || 0, contactId: r.contactId || 0, createdAt: Date.now(), msgs: [], adminReadSeq: 0 };
      convs.set(id, c);
      pushMsg(c, "client", b.name);
      return send(res, 200, { ok: true, convId: id, leadId: r.leadId || 0 });
    }
    return send(res, 400, { ok: false });
  }
  if (u === "/api/send" && req.method === "POST") {
    if (limited(ip(req), 60)) return send(res, 429, { ok: false });
    const b = await readBody(req); const c = conv(b.convId);
    if (!c) return send(res, 404, { ok: false });
    const m = pushMsg(c, "client", b.text);
    note(c.leadId, "Cliente: " + clean(b.text, 800));
    return send(res, 200, { ok: true, id: m.id });
  }
  if (u === "/api/poll" && req.method === "GET") {
    const c = conv(q.get("convId"));
    if (!c) return send(res, 200, { ok: false, msgs: [] });
    return send(res, 200, { ok: true, msgs: msgsAfter(c, parseInt(q.get("after") || "0", 10)) });
  }

  // ---------- BOT 463: crear jugador desde el Salesbot de Kommo ----------
  // POST /api/463/create?key=BOT_SECRET  body: {lead_id, name}  (acepta JSON o form; {{lead.id}} en la URL tambien)
  if (u === "/api/463/create" && req.method === "POST") {
    if ((q.get("key") || "") !== (process.env.BOT_SECRET || "")) return send(res, 401, { ok: false });
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on("end", async () => {
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch (e) { b = Object.fromEntries(new URLSearchParams(raw)); }
      const pick = (...ks) => { for (const k of ks) { const v = k.split(".").reduce((o, p) => (o && o[p] != null ? o[p] : undefined), b); if (v != null && String(v).trim()) return String(v).trim(); } return ""; };
      const leadId = q.get("lead_id") || pick("lead_id", "leadId", "data.lead_id", "lead.id", "leads[add][0][id]", "leads[status][0][id]");
      let name = q.get("name") || pick("name", "nombre", "data.name", "data.nombre", "message", "data.message");
      const clid = q.get("cl_id") || pick("cl_id", "data.cl_id");
      if (!leadId) return send(res, 400, { ok: false, error: "sin lead_id" });
      // Modo Salesbot (widget_request): Kommo manda return_url y espera que le contestemos en <2s; el resultado se le
      // devuelve DESPUES con POST al return_url ({data:{message}, execute_handlers:[goto step]}).
      const returnUrl = pick("return_url");
      const nextStep = parseInt(q.get("next") || "2", 10);
      const finish = (out) => {
        if (!returnUrl) return send(res, 200, out);
        const msg = out.ok ? out.message : (out.error === "nombre invalido" ? "No entendi tu nombre. Escribilo solo con letras, por favor." : "Dame un segundo, un asesor te activa la cuenta enseguida.");
        const body = { data: { message: msg, ok: out.ok ? "1" : "0", login: out.login || "", password: out.password || "" },
          execute_handlers: [{ handler: "goto", params: { type: "question", step: out.ok ? nextStep : nextStep + 1 } }] };
        return fetch(returnUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOK }, body: JSON.stringify(body) })
          .then((r) => console.log("continue ->", r.status)).catch((e) => console.log("continue error", e && e.message));
      };
      if (returnUrl) send(res, 200, { ok: true, queued: true }); // ack inmediato a Kommo
      try {
        const F = await fieldIds();
        const lead = (await kommo("/leads/" + leadId, "GET")).json || {};
        const cur = fieldMap(lead);
        if (!name) name = cur["Nombre cliente"] || lead.name || "";
        name = String(name).replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 60);
        if (cur["Usuario 463"]) { // idempotente: ya tiene cuenta
          return finish({ ok: true, already: true, login: cur["Usuario 463"], password: cur["Clave 463"], message: bot.accessMessage(name, cur["Usuario 463"], cur["Clave 463"]) });
        }
        if (!name || name.length < 2) { await setFields(leadId, F, { "Estado IA": "sin nombre" }); return finish({ ok: false, error: "nombre invalido" }); }
        const r = await bot.createForName(name);
        if (!r.ok) {
          await setFields(leadId, F, { "Nombre cliente": name, "Estado IA": "error: " + r.error.slice(0, 120) });
          await kommo("/leads/" + leadId + "/notes", "POST", [{ note_type: "common", params: { text: "BOT 463: no pude crear la cuenta (" + r.error.slice(0, 200) + "). Atender a mano." } }]).catch(() => {});
          return finish({ ok: false, error: r.error });
        }
        await setFields(leadId, F, { "Nombre cliente": name, "Usuario 463": r.login, "Clave 463": r.password, "Estado IA": "cuenta creada", ...(clid ? { "Origen anuncio": clid } : {}) });
        await kommo("/leads/" + leadId, "PATCH", { name: r.login, _embedded: { tags: [{ name: "cuenta-creada" }, { name: "chat-web" }] } }).catch(() => {});
        await kommo("/leads/" + leadId + "/notes", "POST", [{ note_type: "common", params: { text: "BOT 463: cuenta creada en el panel. Usuario " + r.login + " / Clave " + r.password + " (id " + r.id + ")" } }]).catch(() => {});
        return finish({ ok: true, login: r.login, password: r.password, message: bot.accessMessage(name, r.login, r.password) });
      } catch (e) {
        return finish({ ok: false, error: String(e && e.message || e).slice(0, 200) });
      }
    });
    return;
  }

  if (u === "/api/463/echo" && req.method === "POST") { let raw=""; req.on("data",(c)=>{raw+=c;}); req.on("end",()=>{ console.log("ECHO continue body:", raw.slice(0,600)); send(res, 202, {}); }); return; }

  // ---------- ADMIN ----------
  if (u.startsWith("/api/admin/")) {
    const key = q.get("key") || (req.headers["x-admin-key"] || "");
    if (key !== ADMIN_KEY) return send(res, 401, { ok: false });
    if (u === "/api/admin/list") {
      const list = [...convs.values()].map((c) => {
        const last = c.msgs[c.msgs.length - 1] || { text: "", ts: c.createdAt, from: "" };
        const unread = c.msgs.filter((m) => m.from === "client" && m.id > c.adminReadSeq).length;
        return { id: c.id, name: c.name, phone: c.phone, last: last.text, from: last.from, ts: last.ts, unread: unread, leadId: c.leadId };
      }).sort((a, b) => b.ts - a.ts);
      return send(res, 200, { ok: true, convs: list });
    }
    if (u === "/api/admin/conv") {
      const c = conv(q.get("id")); if (!c) return send(res, 404, { ok: false });
      if (q.get("read") === "1") c.adminReadSeq = SEQ - 1;
      return send(res, 200, { ok: true, name: c.name, phone: c.phone, clid: c.clid, leadId: c.leadId, msgs: msgsAfter(c, parseInt(q.get("after") || "0", 10)) });
    }
    if (u === "/api/admin/reply" && req.method === "POST") {
      const b = await readBody(req); const c = conv(b.id); if (!c) return send(res, 404, { ok: false });
      const m = pushMsg(c, "admin", b.text);
      note(c.leadId, "Asesor: " + clean(b.text, 800));
      return send(res, 200, { ok: true, id: m.id });
    }
    if (u === "/api/admin/phone" && req.method === "POST") {
      const b = await readBody(req); const c = conv(b.id); if (!c) return send(res, 404, { ok: false });
      c.phone = clean(b.phone, 40); setPhone(c.contactId, b.phone); note(c.leadId, "Telefono: " + c.phone);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false });
  }

  send(res, 404, { ok: false });
});
server.listen(PORT, () => {
  console.log("casino-chat 2-vias en puerto " + PORT);
  loadFromKommo();
  setInterval(loadFromKommo, 90000);
  // keep-alive: en plan free Render duerme a los 15 min sin trafico; un ping propio cada 10 min lo mantiene despierto
  const pub = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "";
  if (pub) setInterval(() => { fetch(pub + "/health").catch(() => {}); }, 10 * 60 * 1000);
  // precalienta la sesion del panel del casino
  bot.adminLogin().catch(() => {});
});
