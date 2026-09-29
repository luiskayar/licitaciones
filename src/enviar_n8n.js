/**
 * Genera data/licitaciones.pdf con los resultados de una búsqueda y lo envía
 * al webhook de n8n. Se llama automáticamente al terminar el análisis
 * (src/index.js y src/server.js); también se puede lanzar a mano con
 * `npm run enviar` para reenviar el último archivo de resultados.
 */

import { readFileSync, readdirSync, writeFileSync, statSync, createReadStream, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import FormData from 'form-data';
import axios from 'axios';
import { ROOT } from './buscador.js';
import { generarHTMLReporte } from './reporte-html.js';

const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://delphos.deinsa.com:5678/webhook/licitaciones';
const NOMBRE_PDF = 'licitaciones.pdf';
const RUTA_PDF = join(ROOT, 'data', NOMBRE_PDF);

async function generarPDF(fecha, licitaciones) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(generarHTMLReporte(fecha, licitaciones), { waitUntil: 'networkidle' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '16mm', left: '14mm', right: '14mm' }
    });
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(RUTA_PDF, pdf);
    return RUTA_PDF;
  } finally {
    await browser.close();
  }
}

async function enviarPDF(rutaPdf, fecha, total) {
  const form = new FormData();
  form.append('data', createReadStream(rutaPdf), { filename: NOMBRE_PDF, contentType: 'application/pdf' });
  form.append('fileName', NOMBRE_PDF);
  form.append('fileSize', String(statSync(rutaPdf).size));
  form.append('fecha', fecha);
  form.append('total', String(total));
  form.append('uploadedAt', new Date().toISOString());

  const response = await axios.post(WEBHOOK_URL, form, {
    headers: {
      ...form.getHeaders(),
      // Sin un User-Agent de navegador el firewall de Deinsa responde 401 a Axios
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    timeout: 60_000
  });
  return response.status;
}

/**
 * Genera el PDF y lo envía a n8n. Nunca lanza: un fallo del webhook no debe
 * impedir que se guarden los resultados de la búsqueda.
 *
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function generarYEnviarReporte(fecha, licitaciones, log = console.log) {
  try {
    const ruta = await generarPDF(fecha, licitaciones);
    log(`📄 PDF generado: data/${NOMBRE_PDF} (${licitaciones.length} licitaciones)`);
    const status = await enviarPDF(ruta, fecha, licitaciones.length);
    log(`📤 ${NOMBRE_PDF} enviado a n8n (status ${status})`);
    return { ok: true, status };
  } catch (err) {
    const detalle = err.response
      ? `status ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    log(`✗ No se pudo enviar ${NOMBRE_PDF} a n8n — ${detalle}`);
    return { ok: false, error: detalle };
  }
}

// ─── Uso manual: reenvía el archivo de resultados más reciente ────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resultsDir = join(ROOT, 'data/results');
  const ultimo = readdirSync(resultsDir)
    .filter(f => /^licitaciones-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .pop();

  if (!ultimo) {
    console.log('No se encontraron archivos JSON de licitaciones.');
    process.exit(0);
  }

  const fecha = ultimo.replace('licitaciones-', '').replace('.json', '');
  const licitaciones = JSON.parse(readFileSync(join(resultsDir, ultimo), 'utf8'));
  const { ok } = await generarYEnviarReporte(fecha, licitaciones);
  process.exit(ok ? 0 : 1);
}
