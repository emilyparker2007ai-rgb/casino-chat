"use strict";
// Chat web (Tomi) -> crea/actualiza leads en Kommo por API v4.
// El token vive SOLO en variables de entorno del servidor (nunca en el navegador ni en el repo).

const http = require("http");
const fs = require("fs");
const path = require("path");

const SUB = process.env.KOMMO_SUBDOMAIN || "";
const TOK = process.env.KOMMO_TOKEN || "";
const PIPELINE_ID = parseInt(process.env.KOMMO_PIPELINE_ID || "10741823", 10);
const STATUS_ID = parseInt(process.env.KOMMO_STATUS_ID || "82365651", 10); // Contacto Inicial
const PORT = process.env.PORT || 3000;

// index.html esta en la raiz del repo (este archivo corre en /server)
let PAGE = "";
try { PAGE = fs.readFileSync(path.join(__dirname, "..", "index.html")); }
catch (e) { PAGE = "<h1>casino-chat</h1>"; }

// --- rate limit simple por IP (anti-spam) ---
const hits = new Map();
function limited(ip) {
  const nowSec = Math.floor(Date.now() / 1000);
  const arr = (hits.get(ip) || []).filter((t) => nowSec - t < 60);
  arr.push(nowSec);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 30; // max 30 req/min por IP
}

async function kommo(pathname, method, body) {
  const res = await fetch("https://" + SUB + ".kommo.com/api/v4" + pathname, {
    method,
    headers: { Authorization: "Bearer " + TOK, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch (e) { json = null; }
  return { status: res.status, json, txt };
}

function clean(s, max) { return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max || 200); }

async function createLead(name, message, clid) {
  const note = "Origen anuncio: " + (clid || "(directo)") + "\nPrimer mensaje: " + clean(message, 500);
  const payload = [{
    name: clean(name, 80) + " (chat web)",
    pipeline_id: PIPELINE_ID,
    status_id: STATUS_ID,
    _embedded: {
      contacts: [{ name: clean(name, 80) }],
      tags: [{ name: "chat-web" }, { name: "463" }],
    },
  }];
  const r = await kommo("/leads/complex", "POST", payload);
  const row = Array.isArray(r.json) ? r.json[0] : null;
  if (!row || !row.id) return { ok: false, detail: r.txt };
  // nota con el origen del anuncio
  await kommo("/leads/" + row.id + "/notes", "POST", [
    { note_type: "common", params: { text: note } },
  ]).catch(() => {});
  return { ok: true, leadId: row.id, contactId: row.contact_id || 0 };
}

async function setPhone(contactId, phone, name) {
  if (!contactId) return { ok: false };
  const r = await kommo("/contacts/" + contactId, "PATCH", {
    custom_fields_values: [
      { field_code: "PHONE", values: [{ value: clean(phone, 40), enum_code: "MOB" }] },
    ],
  });
  return { ok: r.status >= 200 && r.status < 300 };
}

async function addNote(leadId, text) {
  if (!leadId) return { ok: false };
  const r = await kommo("/leads/" + leadId + "/notes", "POST", [
    { note_type: "common", params: { text: clean(text, 900) } },
  ]);
  return { ok: r.status >= 200 && r.status < 300 };
}

function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = req.url.split("?")[0];

  if (req.method === "OPTIONS") { json(res, 204, {}); return; }
  if (u === "/health") { json(res, 200, { ok: true }); return; }

  if (req.method === "GET" && (u === "/" || u === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=120" });
    res.end(PAGE);
    return;
  }

  if (req.method === "POST" && u === "/api/lead") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (limited(ip)) { json(res, 429, { ok: false, error: "rate" }); return; }
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 8000) req.destroy(); });
    req.on("end", async () => {
      let b = {};
      try { b = JSON.parse(raw || "{}"); } catch (e) { json(res, 400, { ok: false }); return; }
      try {
        if (b.action === "create") {
          const r = await createLead(b.name, b.message, b.clid);
          json(res, 200, r);
        } else if (b.action === "phone") {
          const r = await setPhone(b.contactId, b.phone, b.name);
          if (b.leadId) await addNote(b.leadId, "WhatsApp que dejo: " + clean(b.phone, 40));
          json(res, 200, r);
        } else if (b.action === "msg") {
          const r = await addNote(b.leadId, "Cliente: " + clean(b.message, 800));
          json(res, 200, r);
        } else {
          json(res, 400, { ok: false, error: "action" });
        }
      } catch (e) {
        json(res, 200, { ok: false, error: "kommo" });
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => { console.log("casino-chat en puerto " + PORT + " (sub=" + SUB + ")"); });
