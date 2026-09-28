/**
 * Construye el sitio estático que se publica en GitHub Pages.
 *
 * Genera en _site/:
 *   - el dashboard (copia de public/)
 *   - data/manifest.json  → índice de fechas, ya que un sitio estático no puede
 *                            listar el contenido de una carpeta
 *   - data/estado.json    → resultado de la última ejecución
 *   - data/results/*.json → los resultados de cada fecha
 *   - data/results/*.pdf  → el reporte impreso, que antes se generaba al vuelo
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generarHTMLReporte } from '../src/reporte-html.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITIO = join(ROOT, '_site');
const RESULTS_ORIGEN = join(ROOT, 'data/results');
const RESULTS_DESTINO = join(SITIO, 'data/results');
const ARCHIVO_RE = /^licitaciones-(\d{4}-\d{2}-\d{2})\.json$/;

function leerResultados() {
  if (!existsSync(RESULTS_ORIGEN)) return [];
  return readdirSync(RESULTS_ORIGEN)
    .map(archivo => {
      const match = archivo.match(ARCHIVO_RE);
      if (!match) return null;
      try {
        const licitaciones = JSON.parse(readFileSync(join(RESULTS_ORIGEN, archivo), 'utf8'));
        return { fecha: match[1], archivo, licitaciones };
      } catch (err) {
        console.warn(`  ⚠️  ${archivo} no se pudo leer: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
}

async function generarPDFs(resultados) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const { fecha, licitaciones } of resultados) {
      await page.setContent(generarHTMLReporte(fecha, licitaciones), { waitUntil: 'networkidle' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', bottom: '16mm', left: '14mm', right: '14mm' }
      });
      writeFileSync(join(RESULTS_DESTINO, `licitaciones-${fecha}.pdf`), pdf);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('=== Construyendo sitio estático ===\n');

  rmSync(SITIO, { recursive: true, force: true });
  mkdirSync(RESULTS_DESTINO, { recursive: true });

  cpSync(join(ROOT, 'public'), SITIO, { recursive: true });
  console.log('✓ Dashboard copiado desde public/');

  const resultados = leerResultados();

  for (const { archivo } of resultados) {
    cpSync(join(RESULTS_ORIGEN, archivo), join(RESULTS_DESTINO, archivo));
  }
  console.log(`✓ ${resultados.length} archivo(s) de resultados copiados`);

  const manifiesto = resultados.map(({ fecha, licitaciones }) => ({
    fecha,
    total: licitaciones.length,
    alta: licitaciones.filter(l => l.nivel_relevancia === 'ALTA').length,
    media: licitaciones.filter(l => l.nivel_relevancia === 'MEDIA').length,
    baja: licitaciones.filter(l => l.nivel_relevancia === 'BAJA').length
  }));
  writeFileSync(join(SITIO, 'data/manifest.json'), JSON.stringify(manifiesto, null, 2), 'utf8');
  console.log('✓ Índice de fechas generado (data/manifest.json)');

  const estadoOrigen = join(ROOT, 'data/estado.json');
  if (existsSync(estadoOrigen)) {
    cpSync(estadoOrigen, join(SITIO, 'data/estado.json'));
    console.log('✓ Estado de la última ejecución copiado');
  }

  // El dashboard necesita saber a qué repositorio apuntar el botón de "ejecutar
  // búsqueda", que abre la pestaña Actions de GitHub.
  writeFileSync(join(SITIO, 'data/sitio.json'), JSON.stringify({
    repositorio: process.env.GITHUB_REPOSITORY ?? null,
    workflow: 'buscar.yml'
  }, null, 2), 'utf8');

  if (resultados.length > 0) {
    await generarPDFs(resultados);
    console.log(`✓ ${resultados.length} PDF(s) generados`);
  }

  console.log(`\n💾 Sitio listo en _site/`);
}

main().catch(err => {
  console.error('Error construyendo el sitio:', err);
  process.exit(1);
});
