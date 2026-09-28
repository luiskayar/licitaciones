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
import { generarHTMLReporte } from './reporte-html.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUERTO = process.env.PORT || 3000;
const RESULTS_DIR = join(ROOT, 'data/results');
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const app = express();
app.use(express.static(join(__dirname, '..', 'public')));
// El dashboard lee los datos por ruta relativa (data/...), igual que en el sitio
// publicado en GitHub Pages, para que el mismo app.js sirva en ambos entornos.
app.use('/data', express.static(join(ROOT, 'data')));

// ─── Equivalentes locales de los archivos que genera el build estático ───────
// En GitHub Pages estos archivos los produce scripts/construir-sitio.js; aquí se
// resuelven al vuelo para no tener que construir el sitio en cada cambio.

app.get('/data/manifest.json', (req, res) => {
  try {
    res.json(listarResultados());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/data/results/licitaciones-:fecha.pdf', async (req, res) => {
  let browser;
  try {
    const licitaciones = leerLicitaciones(req.params.fecha);
    if (licitaciones === null) return res.status(404).json({ error: 'No hay resultados para esa fecha' });

    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(generarHTMLReporte(req.params.fecha, licitaciones), { waitUntil: 'networkidle' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '16mm', left: '14mm', right: '14mm' }
    });
    res.set('Content-Type', 'application/pdf').send(pdf);
  } catch (err) {
    res.status(500).json({ error: `No se pudo generar el PDF: ${err.message}` });
  } finally {
    if (browser) await browser.close();
  }
});

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

app.listen(PUERTO, () => {
  console.log(`\n=== DELPHOS Licitaciones ===`);
  console.log(`Servidor corriendo en http://localhost:${PUERTO}\n`);
});
