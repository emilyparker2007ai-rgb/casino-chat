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
});
