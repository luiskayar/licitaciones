/**
 * Servidor web de DELPHOS Licitaciones.
 * Sirve el dashboard (public/) y expone la API para listar resultados,
 * lanzar una búsqueda nueva (con progreso en vivo por SSE) y descargar
 * los resultados en JSON o PDF.
 */

import express from 'express';
import { chromium } from 'playwright';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ejecutarBusqueda, ROOT } from './buscador.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUERTO = process.env.PORT || 3000;
const RESULTS_DIR = join(ROOT, 'data/results');
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const app = express();
app.use(express.static(join(__dirname, '..', 'public')));

// ─── Estado del job de búsqueda (uno a la vez, en memoria) ───────────────────

const job = {
  estado: 'inactivo', // inactivo | ejecutando | completado | error
  progreso: 0,
  eventos: [],
  resumen: null,
  error: null
};
const clientesSSE = new Set();

function emitir(evento) {
  const conTimestamp = { ...evento, ts: Date.now() };
  job.eventos.push(conTimestamp);
  if (job.eventos.length > 500) job.eventos.shift();
  if (typeof evento.progress === 'number') job.progreso = evento.progress;
  for (const res of clientesSSE) {
    res.write(`data: ${JSON.stringify(conTimestamp)}\n\n`);
  }
}

async function lanzarBusqueda() {
  if (job.estado === 'ejecutando') return false;

  job.estado = 'ejecutando';
  job.progreso = 0;
  job.eventos = [];
  job.resumen = null;
  job.error = null;
  emitir({ type: 'server-inicio', message: 'Búsqueda iniciada', progress: 0 });

  try {
    const { resumen } = await ejecutarBusqueda(emitir);
    job.estado = 'completado';
    job.resumen = resumen;
    emitir({ type: 'server-fin', message: 'Búsqueda finalizada', progress: 100, data: resumen });
  } catch (err) {
    job.estado = 'error';
    job.error = err.message;
    emitir({ type: 'server-error', message: `Error inesperado: ${err.message}`, progress: job.progreso });
  }
  return true;
}

// ─── API: estado y progreso ───────────────────────────────────────────────────

app.get('/api/estado', (req, res) => {
  res.json({ estado: job.estado, progreso: job.progreso, resumen: job.resumen, error: job.error });
});

app.get('/api/buscar/eventos', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({ type: 'server-estado', estado: job.estado, progress: job.progreso })}\n\n`);
  for (const evento of job.eventos) {
    res.write(`data: ${JSON.stringify(evento)}\n\n`);
  }
  clientesSSE.add(res);
  req.on('close', () => clientesSSE.delete(res));
});

app.post('/api/buscar', express.json(), async (req, res) => {
  if (job.estado === 'ejecutando') {
    return res.status(409).json({ ok: false, error: 'Ya hay una búsqueda en curso' });
  }
  res.status(202).json({ ok: true });
  lanzarBusqueda().catch(err => {
    // Red de seguridad extra: lanzarBusqueda ya captura sus propios errores,
    // esto solo cubre fallos totalmente inesperados fuera de ese try/catch.
    job.estado = 'error';
    job.error = err.message;
    emitir({ type: 'server-error', message: `Error inesperado: ${err.message}` });
  });
});

// ─── API: resultados guardados ────────────────────────────────────────────────

function listarResultados() {
  if (!existsSync(RESULTS_DIR)) return [];
  return readdirSync(RESULTS_DIR)
    .filter(f => /^licitaciones-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => {
      const fecha = f.replace('licitaciones-', '').replace('.json', '');
      let licitaciones = [];
      try {
        licitaciones = JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8'));
      } catch {
        licitaciones = [];
      }
      return {
        fecha,
        total: licitaciones.length,
        alta: licitaciones.filter(l => l.nivel_relevancia === 'ALTA').length,
        media: licitaciones.filter(l => l.nivel_relevancia === 'MEDIA').length,
        baja: licitaciones.filter(l => l.nivel_relevancia === 'BAJA').length
      };
    })
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
}

app.get('/api/resultados', (req, res) => {
  try {
    res.json(listarResultados());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function leerLicitaciones(fecha) {
  if (!FECHA_RE.test(fecha)) return null;
  const archivo = join(RESULTS_DIR, `licitaciones-${fecha}.json`);
  if (!existsSync(archivo)) return null;
  return JSON.parse(readFileSync(archivo, 'utf8'));
}

app.get('/api/resultados/:fecha', (req, res) => {
  try {
    const licitaciones = leerLicitaciones(req.params.fecha);
    if (licitaciones === null) return res.status(404).json({ error: 'No hay resultados para esa fecha' });
    res.json(licitaciones);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resultados/:fecha/descargar', (req, res) => {
  const { fecha } = req.params;
  if (!FECHA_RE.test(fecha)) return res.status(400).json({ error: 'Fecha inválida' });
  const archivo = join(RESULTS_DIR, `licitaciones-${fecha}.json`);
  if (!existsSync(archivo)) return res.status(404).json({ error: 'No hay resultados para esa fecha' });
  res.download(archivo, `licitaciones-${fecha}.json`);
});

app.get('/api/resultados/:fecha/pdf', async (req, res) => {
  let browser;
  try {
    const licitaciones = leerLicitaciones(req.params.fecha);
    if (licitaciones === null) return res.status(404).json({ error: 'No hay resultados para esa fecha' });

    const html = generarHTMLReporte(req.params.fecha, licitaciones);
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '16mm', left: '14mm', right: '14mm' }
    });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="licitaciones-${req.params.fecha}.pdf"`
    });
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: `No se pudo generar el PDF: ${err.message}` });
  } finally {
    if (browser) await browser.close();
  }
});

function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function generarHTMLReporte(fecha, licitaciones) {
  const colorNivel = { ALTA: '#b3261e', MEDIA: '#8a5a00', BAJA: '#555' };
  const filas = licitaciones.map(l => {
    const monto = l.monto_estimado
      ? `${escapeHTML(l.moneda || '')} ${Number(l.monto_estimado).toLocaleString('es-CL')}`
      : 'Monto no publicado';
    const cierre = l.dias_hasta_cierre != null
      ? `${escapeHTML(l.fecha_cierre)} (faltan ${l.dias_hasta_cierre} días)`
      : (l.fecha_cierre ? escapeHTML(l.fecha_cierre) : 'Sin fecha de cierre');
    return `
      <div class="item">
        <div class="item-header">
          <span class="badge" style="color:${colorNivel[l.nivel_relevancia] || '#333'}">${escapeHTML(l.nivel_relevancia || '')}</span>
          <span class="titulo">${escapeHTML(l.titulo)}</span>
        </div>
        <div class="meta">${escapeHTML(l.entidad)}${l.region ? ' — ' + escapeHTML(l.region) : ''} · ${escapeHTML(l.pais)} · ${escapeHTML(l.portal)}</div>
        <div class="meta">💰 ${monto} &nbsp;|&nbsp; 📅 ${cierre}</div>
        ${l.numero_expediente ? `<div class="meta">📋 Expediente: ${escapeHTML(l.numero_expediente)}</div>` : ''}
        ${l.razon_gemini ? `<div class="razon">🤖 ${escapeHTML(l.razon_gemini)}</div>` : ''}
        <div class="link">${escapeHTML(l.url)}</div>
      </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 11px; }
  h1 { font-size: 18px; margin-bottom: 2px; }
  .subtitulo { color: #666; margin-bottom: 18px; }
  .item { border: 1px solid #ddd; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; page-break-inside: avoid; }
  .item-header { display: flex; gap: 8px; align-items: baseline; margin-bottom: 4px; }
  .badge { font-weight: bold; font-size: 10px; letter-spacing: .03em; }
  .titulo { font-weight: bold; font-size: 12px; }
  .meta { color: #444; margin-bottom: 2px; }
  .razon { color: #333; font-style: italic; margin-top: 4px; }
  .link { color: #1a56db; word-break: break-all; margin-top: 4px; font-size: 10px; }
</style>
</head>
<body>
  <h1>DELPHOS — Licitaciones relevantes</h1>
  <div class="subtitulo">Fecha de búsqueda: ${escapeHTML(fecha)} · ${licitaciones.length} resultado(s)</div>
  ${filas || '<p>Sin licitaciones para esta fecha.</p>'}
</body>
</html>`;
}

app.listen(PUERTO, () => {
  console.log(`\n=== DELPHOS Licitaciones ===`);
  console.log(`Servidor corriendo en http://localhost:${PUERTO}\n`);
});
