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

// ---- rotador de lineas de WhatsApp ----
// WA_PHONES: numeros separados por coma. Acepta local ("1157402506") o internacional.
function waNorm(raw) {
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (!d.startsWith("54")) d = "549" + d;                 // local argentino -> movil
  else if (!d.startsWith("549")) d = "549" + d.slice(2);  // 54 sin el 9
  return d;
}
const WA_LIST = String(process.env.WA_PHONES || process.env.WA_PHONE || "1157402506")
  .split(",").map((x) => waNorm(x)).filter((x) => x.length >= 12);
let waIdx = 0;
function waNext() {
  const n = WA_LIST[waIdx % WA_LIST.length];
  waIdx = (waIdx + 1) % (WA_LIST.length * 1000);
  return n;
}

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
const stats = require("./stats");
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
  if (u === "/health") return send(res, 200, { ok: true, convs: convs.size, wa_lineas: WA_LIST.length });

  if (req.method === "GET" && (u === "/" || u === "/index.html"))
    return send(res, 200, INDEX, "text/html; charset=utf-8");
  if (req.method === "GET" && (u === "/admin" || u === "/admin.html"))
    return send(res, 200, ADMIN, "text/html; charset=utf-8");
  // ---------- analytics ----------
  if (req.method === "GET" && (u === "/stats" || u === "/api/stats")) {
    if (q.get("key") !== ADMIN_KEY) return send(res, 401, { ok: false, error: "clave invalida" });
    const data = stats.reporte(q.get("dias"));
    if (u === "/api/stats") return send(res, 200, { ok: true, ...data });
    return send(res, 200, panelHTML(data, q.get("key")), "text/html; charset=utf-8");
  }

  // ---------- landings estaticas ----------
  // Cada entrada es una ruta publica -> carpeta en disco. Agregar una variante es una linea mas.
  const LANDINGS = { "463": "landing-463", "ganar": "landing-463-ganar", "grupo": "landing-grupo" };
  const TIPOS = { ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg" };
  const seg = u.split("/")[1] || "";

  if (req.method === "GET" && LANDINGS[seg]) {
    const resto = u.slice(seg.length + 2);   // lo que va despues de "/<seg>/"

    // baliza de permanencia: la manda la propia pagina a los 2 segundos.
    // Separa a una persona mirando de una precarga del navegador interno de Meta.
    if (resto === "ok") {
      stats.track("e", seg, req, q.get("ref"));
      res.writeHead(204, { "Cache-Control": "no-store" });
      return res.end();
    }

    // salida a WhatsApp desde NUESTRO dominio: la pagina no contiene ningun link de WhatsApp
    if (resto === "ir") {
      // la landing del grupo no manda a un chat individual sino al link de invitacion
      stats.track("c", seg, req, q.get("ref"));
      if (seg === "grupo") {
        // acepta el link como sea que lo peguen (el boton de compartir le suma ?s=sw&p=a...)
        // y redirige siempre a la forma canonica
        const m = String(process.env.WA_GROUP || "").match(/chat\.whatsapp\.com\/([A-Za-z0-9]{6,40})/);
        if (!m) return send(res, 503, { ok: false, error: "falta configurar WA_GROUP" });
        const dest = "https://chat.whatsapp.com/" + m[1];
        res.writeHead(302, { Location: dest, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        return res.end();
      }
      const phone = waNext();
      const ref = (q.get("ref") || "").replace(/[^\w-]/g, "").slice(0, 20);
      const texto = (q.get("t") === "premio")
        ? "Hola! Quiero crear mi usuario para jugar por los premios" + (ref ? " (ref " + ref + ")" : "")
        : "Hola! Quiero crear mi usuario y aprovechar el 200% de bono" + (ref ? " (ref " + ref + ")" : "");
      const dest = "https://api.whatsapp.com/send?phone=" + phone + "&text=" + encodeURIComponent(texto);
      res.writeHead(302, { Location: dest, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      return res.end();
    }

    // sin barra final los relativos se resuelven contra la raiz y el logo da 404
    if (u === "/" + seg) { res.writeHead(301, { Location: "/" + seg + "/" }); return res.end(); }

    const rel = resto === "" ? "index.html" : resto.replace(/\.\./g, "");
    if (rel === "index.html") {
      stats.track("v", seg, req, q.get("utm_content") || q.get("utm_campaign") || q.get("ref"), q.get("fbclid"));
    }
    const ext = rel.slice(rel.lastIndexOf("."));
    try {
      const buf = fs.readFileSync(path.join(__dirname, "..", LANDINGS[seg], rel));
      res.writeHead(200, { "Content-Type": TIPOS[ext] || "application/octet-stream", "Cache-Control": "public, max-age=3600" });
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

// ---------- tablero de analytics (HTML, sin librerias) ----------
function panelHTML(d, key) {
  const esc = (x) => String(x).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const NOMBRE = { "463": "Bono 200%", ganar: "Premio pagado", grupo: "Grupo WhatsApp" };
  const nom = (L) => NOMBRE[L] || L;

  const totF = Object.values(d.fuentes || {}).reduce((a, b) => a + b, 0) || 1;
  const fuentes = Object.keys(d.fuentes || {}).length
    ? Object.keys(d.fuentes).sort((a, b) => d.fuentes[b] - d.fuentes[a]).map((f) =>
        '<tr><td>' + esc(f) + '</td><td class="n">' + d.fuentes[f] + '</td>' +
        '<td class="n tasa">' + Math.round((d.fuentes[f] / totF) * 100) + '%</td></tr>').join("")
    : '<tr><td colspan="3" class="vacio">Sin datos todavia</td></tr>';

  const maxDia = Math.max(1, ...d.porDia.map((x) => x.v));
  const barras = d.porDia.map((x) => {
    const alto = Math.round((x.v / maxDia) * 100);
    const dd = x.dia.slice(8) + "/" + x.dia.slice(5, 7);
    return '<div class="bar"><div class="col"><span style="height:' + Math.max(alto, 2) + '%"></span></div>' +
      '<b>' + x.v + '</b><i>' + dd + '</i></div>';
  }).join("");

  const maxHora = Math.max(1, ...Object.values(d.horas).map((h) => h.v));
  let horas = "";
  for (let h = 0; h < 24; h++) {
    const x = d.horas[h] || { v: 0, c: 0 };
    const alto = Math.round((x.v / maxHora) * 100);
    horas += '<div class="hb" title="' + h + 'h: ' + x.v + ' visitas, ' + x.c + ' clics">' +
      '<span style="height:' + Math.max(alto, 2) + '%"></span><i>' + (h % 6 === 0 ? h : "") + '</i></div>';
  }

  const filas = Object.keys(d.porLanding).length
    ? Object.keys(d.porLanding).sort().map((L) => {
        const b = d.porLanding[L];
        return '<tr><td><b>' + esc(nom(L)) + '</b><small>/' + esc(L) + '</small></td>' +
          '<td class="n">' + b.v + '</td><td class="n">' + b.vu + '</td>' +
          '<td class="n">' + b.c + '</td><td class="n tasa">' + b.tasa + '%</td></tr>';
      }).join("")
    : '<tr><td colspan="5" class="vacio">Todavia no entro nadie hoy</td></tr>';

  const refs = d.topRefs.length
    ? d.topRefs.map((r) => '<tr><td>' + esc(r.ref) + '</td><td class="n">' + r.v + '</td>' +
        '<td class="n">' + r.c + '</td><td class="n tasa">' + r.tasa + '%</td></tr>').join("")
    : '<tr><td colspan="4" class="vacio">Sin datos todavia</td></tr>';

  const vivo = d.ultimos.length
    ? d.ultimos.map((e) => {
        const t = new Date(e.ts).toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", second: "2-digit" });
        return '<li><span class="' + (e.kind === "c" ? "pc" : "pv") + '">' + (e.kind === "c" ? "CLIC" : "visita") + '</span>' +
          '<b>' + esc(nom(e.landing)) + '</b><em>' + esc(e.ref) + '</em><i>' + t + '</i></li>';
      }).join("")
    : '<li class="vacio">Sin movimiento todavia</li>';

  return '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1"><title>Analytics 463</title>' +
'<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><text y=\'78\' font-size=\'78\' text-anchor=\'middle\' x=\'50\'>%F0%9F%93%8A</text></svg>">' +
'<style>' +
':root{--bg:#0b0d10;--card:#12161b;--line:#1e252d;--ink:#e9edf2;--mut:#8b96a3;--gold:#ffd24a;--wa:#25d366;--blue:#5aa9ff}' +
'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI",system-ui,-apple-system,Roboto,sans-serif}' +
'.wrap{max-width:1000px;margin:0 auto;padding:22px 16px 60px}' +
'header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px}' +
'h1{font-size:19px;margin:0;letter-spacing:.2px}h1 span{color:var(--mut);font-weight:400;font-size:14px}' +
'.live{font-size:12px;color:var(--mut)}.live b{color:var(--wa)}' +
'.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px;margin-bottom:20px}' +
'.k{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:14px 16px}' +
'.k u{display:block;text-decoration:none;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);margin-bottom:5px}' +
'.k b{display:block;font-size:30px;line-height:1.1;font-variant-numeric:tabular-nums}' +
'.k.g b{color:var(--gold)}.k.w b{color:var(--wa)}.k.b b{color:var(--blue)}' +
'.k small{color:var(--mut);font-size:12px}' +
'section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}' +
'h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);margin:0 0 14px}' +
'table{width:100%;border-collapse:collapse;font-size:14px}' +
'th{text-align:right;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);padding:0 0 8px;font-weight:600}' +
'th:first-child,td:first-child{text-align:left}' +
'td{padding:9px 0;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}' +
'td.n{text-align:right}td.tasa{color:var(--wa);font-weight:700}' +
'td small{display:block;color:var(--mut);font-size:11.5px}.vacio{color:var(--mut);text-align:center;padding:18px 0}' +
'.chart{display:flex;align-items:flex-end;justify-content:center;gap:8px;height:150px}' +
'.bar{flex:1;max-width:88px;display:flex;flex-direction:column;align-items:center;gap:5px;height:100%}' +
'.col{flex:1;width:100%;display:flex;align-items:flex-end}' +
'.col span{width:100%;background:linear-gradient(180deg,var(--gold),#8a5f0c);border-radius:5px 5px 0 0;min-height:3px}' +
'.bar b{font-size:12.5px;font-variant-numeric:tabular-nums}.bar i{font-size:10.5px;color:var(--mut);font-style:normal}' +
'.horas{display:flex;align-items:flex-end;gap:3px;height:80px}' +
'.hb{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%}' +
'.hb span{width:100%;background:var(--blue);border-radius:3px 3px 0 0;min-height:2px;opacity:.75}' +
'.hb i{font-size:9.5px;color:var(--mut);font-style:normal;height:12px}' +
'ul{list-style:none;margin:0;padding:0;max-height:300px;overflow:auto}' +
'li{display:flex;align-items:center;gap:9px;padding:7px 0;border-top:1px solid var(--line);font-size:13.5px}' +
'li span{font-size:10px;font-weight:800;letter-spacing:.06em;padding:3px 7px;border-radius:5px;flex:0 0 auto}' +
'.pv{background:#17222e;color:var(--blue)}.pc{background:#12301f;color:var(--wa)}' +
'li b{font-weight:600}li em{color:var(--mut);font-style:normal;font-size:12px}li i{margin-left:auto;color:var(--mut);font-style:normal;font-size:12px;font-variant-numeric:tabular-nums}' +
'.nota{color:var(--mut);font-size:12.5px;line-height:1.6;margin-top:16px}' +
'@media(max-width:560px){.k b{font-size:25px}.chart{height:120px}}' +
'</style></head><body><div class="wrap">' +
'<header><h1>Analytics <span>&middot; ' + esc(d.dia) + ' (hora de Argentina)</span></h1>' +
'<div class="live">se actualiza solo cada 30 s &middot; <b>en vivo</b></div></header>' +
'<div class="kpis">' +
'<div class="k b"><u>Visitas hoy</u><b>' + d.hoy.v + '</b><small>' + d.hoy.vu + ' personas distintas</small></div>' +
'<div class="k"><u>Se quedan 2 s</u><b>' + d.hoy.quedan + '%</b><small>' + d.hoy.e + ' de ' + d.hoy.v + ' &middot; el resto rebota o es precarga</small></div>' +
'<div class="k w"><u>Clics al boton</u><b>' + d.hoy.c + '</b><small>tocaron para escribir</small></div>' +
'<div class="k g"><u>Convierten</u><b>' + d.hoy.tasa + '%</b><small>de los que entran</small></div>' +
'<div class="k"><u>Acumulado</u><b>' + d.total.v + '</b><small>' + d.total.c + ' clics en total</small></div>' +
'</div>' +
'<section><h2>De donde viene el trafico (hoy)</h2><table><tr><th>Fuente</th><th>Visitas</th><th>%</th></tr>' + fuentes + '</table>' +
'<p class="nota" style="margin-top:10px">Con <b>' + d.hoy.fb + '</b> visitas llego el codigo <b>fbclid</b>, que Meta agrega a todo clic pago: ese es el trafico que realmente vino del anuncio.</p></section>' +
'<section><h2>Hoy, por landing</h2><table><tr><th>Landing</th><th>Visitas</th><th>Personas</th><th>Clics</th><th>Convierte</th></tr>' + filas + '</table></section>' +
'<section><h2>Visitas por dia</h2><div class="chart">' + barras + '</div></section>' +
'<section><h2>Hoy, hora por hora</h2><div class="horas">' + horas + '</div></section>' +
'<section><h2>De que anuncio vienen (hoy)</h2><table><tr><th>Codigo</th><th>Visitas</th><th>Clics</th><th>Convierte</th></tr>' + refs + '</table></section>' +
'<section><h2>Ultimos movimientos</h2><ul>' + vivo + '</ul></section>' +
'<p class="nota">Se cuenta del lado del servidor, sin scripts ni cookies en la landing: no lo frenan los bloqueadores. ' +
'Se descartan bots y las vistas previas de WhatsApp y Meta. &laquo;Personas distintas&raquo; es un calculo aproximado del dia, no permite identificar a nadie.<br>' +
'Los datos se pierden cuando se hace un deploy nuevo, porque el servicio no tiene disco propio.</p>' +
'</div><script>setTimeout(function(){location.reload()},30000)</script></body></html>';
}
