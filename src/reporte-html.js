/**
 * Generador del HTML que se imprime como PDF de resultados.
 * Lo usan el servidor local (src/server.js) y el build estático
 * (scripts/construir-sitio.js).
 */

export function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function generarHTMLReporte(fecha, licitaciones) {
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
