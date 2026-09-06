"use strict";
// Analytics propio, del lado del servidor.
// No hay script en la landing: la visita se cuenta al servir el HTML y el clic
// al pasar por el redirect. Por eso no lo frenan los bloqueadores ni suma peso.
// Sin cookies: el visitante unico es un hash del dia que no permite reidentificar a nadie.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ARCHIVO = process.env.STATS_FILE || "/tmp/stats-463.json";
const SAL = crypto.randomBytes(16).toString("hex"); // rota al reiniciar: el hash no sirve para seguir a nadie
const DIAS_QUE_GUARDO = 60;

// Bots y previsualizaciones. Sin esto WhatsApp y Meta inflan las visitas al generar la vista previa del link.
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|headless|lighthouse|pingdom|uptime|monitor|scraper|semrush|ahrefs|bingpreview|embed/i;

const dias = new Map();   // "2026-09-05" -> { landing -> {v,c,vu:Set,cu:Set, horas:{}, refs:{}} }
const ultimos = [];       // ultimos eventos para el detalle en vivo
let total = { v: 0, c: 0 };

function hoyAR(ts) {
  const d = new Date(ts == null ? Date.now() : ts);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
function horaAR(ts) {
  const d = new Date(ts == null ? Date.now() : ts);
  return parseInt(new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", hour12: false,
  }).format(d), 10);
}
function ipDe(req) {
  return String(req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "")
    .split(",")[0].trim();
}
function huella(req) {
  const base = ipDe(req) + "|" + (req.headers["user-agent"] || "") + "|" + hoyAR();
  return crypto.createHmac("sha256", SAL).update(base).digest("hex").slice(0, 16);
}
function esBot(req) {
  const ua = String(req.headers["user-agent"] || "");
  return !ua || BOTS.test(ua);
}
function cajaDia(dia, landing) {
  if (!dias.has(dia)) dias.set(dia, {});
  const d = dias.get(dia);
  if (!d[landing]) d[landing] = { v: 0, c: 0, vu: new Set(), cu: new Set(), horas: {}, refs: {} };
  return d[landing];
}
function limpiar() {
  const claves = [...dias.keys()].sort();
  while (claves.length > DIAS_QUE_GUARDO) dias.delete(claves.shift());
}

// kind: "v" (visita) | "c" (clic en el boton)
function track(kind, landing, req, ref) {
  if (esBot(req)) return;
  const ts = Date.now();
  const dia = hoyAR(ts);
  const box = cajaDia(dia, landing);
  const h = huella(req);
  const r = String(ref || "").replace(/[^\w-]/g, "").slice(0, 24) || "(directo)";

  box[kind]++;
  (kind === "v" ? box.vu : box.cu).add(h);
  const hh = horaAR(ts);
  if (!box.horas[hh]) box.horas[hh] = { v: 0, c: 0 };
  box.horas[hh][kind]++;
  if (!box.refs[r]) box.refs[r] = { v: 0, c: 0 };
  box.refs[r][kind]++;

  total[kind]++;
  ultimos.push({ ts, kind, landing, ref: r, pais: req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"] || "" });
  if (ultimos.length > 400) ultimos.splice(0, ultimos.length - 400);
  limpiar();
}

function reporte(nDias) {
  const n = Math.min(Math.max(parseInt(nDias || 7, 10), 1), 60);
  // se arma la serie completa hacia atras, con ceros en los dias sin trafico:
  // asi el grafico tiene la misma forma desde el primer dia
  const claves = [];
  for (let i = n - 1; i >= 0; i--) claves.push(hoyAR(Date.now() - i * 86400000));
  const porDia = claves.map((dia) => {
    const d = dias.get(dia) || {};
    const fila = { dia, landings: {}, v: 0, c: 0, vu: 0 };
    Object.keys(d).forEach((L) => {
      const b = d[L];
      fila.landings[L] = { v: b.v, c: b.c, vu: b.vu.size, cu: b.cu.size };
      fila.v += b.v; fila.c += b.c; fila.vu += b.vu.size;
    });
    return fila;
  });

  const dia = hoyAR();
  const hoy = dias.get(dia) || {};
  const porLanding = {};
  let hv = 0, hc = 0, hvu = 0;
  Object.keys(hoy).forEach((L) => {
    const b = hoy[L];
    porLanding[L] = { v: b.v, c: b.c, vu: b.vu.size, cu: b.cu.size,
      tasa: b.v ? Math.round((b.c / b.v) * 1000) / 10 : 0 };
    hv += b.v; hc += b.c; hvu += b.vu.size;
  });

  const horas = {};
  Object.keys(hoy).forEach((L) => Object.keys(hoy[L].horas).forEach((h) => {
    if (!horas[h]) horas[h] = { v: 0, c: 0 };
    horas[h].v += hoy[L].horas[h].v; horas[h].c += hoy[L].horas[h].c;
  }));

  const refs = {};
  Object.keys(hoy).forEach((L) => Object.keys(hoy[L].refs).forEach((r) => {
    if (!refs[r]) refs[r] = { v: 0, c: 0 };
    refs[r].v += hoy[L].refs[r].v; refs[r].c += hoy[L].refs[r].c;
  }));
  const topRefs = Object.keys(refs).map((r) => ({ ref: r, ...refs[r],
    tasa: refs[r].v ? Math.round((refs[r].c / refs[r].v) * 1000) / 10 : 0 }))
    .sort((a, b) => b.v - a.v).slice(0, 12);

  return {
    dia, desde: arranque,
    hoy: { v: hv, c: hc, vu: hvu, tasa: hv ? Math.round((hc / hv) * 1000) / 10 : 0 },
    porLanding, horas, topRefs, porDia, total,
    ultimos: ultimos.slice(-40).reverse(),
  };
}

// ---------- persistencia entre reinicios (no sobrevive a un deploy) ----------
function guardar() {
  try {
    const plano = {};
    dias.forEach((d, dia) => {
      plano[dia] = {};
      Object.keys(d).forEach((L) => {
        const b = d[L];
        plano[dia][L] = { v: b.v, c: b.c, vu: [...b.vu], cu: [...b.cu], horas: b.horas, refs: b.refs };
      });
    });
    fs.writeFileSync(ARCHIVO, JSON.stringify({ total, dias: plano, arranque }), "utf8");
  } catch (e) { /* si no puede escribir, sigue contando en memoria */ }
}
function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(ARCHIVO, "utf8"));
    Object.keys(j.dias || {}).forEach((dia) => {
      Object.keys(j.dias[dia]).forEach((L) => {
        const b = j.dias[dia][L];
        const box = cajaDia(dia, L);
        box.v = b.v || 0; box.c = b.c || 0;
        (b.vu || []).forEach((x) => box.vu.add(x));
        (b.cu || []).forEach((x) => box.cu.add(x));
        box.horas = b.horas || {}; box.refs = b.refs || {};
      });
    });
    if (j.total) total = j.total;
    return j.arranque || Date.now();
  } catch (e) { return Date.now(); }
}

const arranque = cargar();
setInterval(guardar, 60000).unref();
process.on("SIGTERM", guardar);
process.on("SIGINT", guardar);

module.exports = { track, reporte, guardar, ARCHIVO };
