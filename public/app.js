const els = {
  bannerError: document.getElementById('banner-error'),
  panelEstado: document.getElementById('panel-estado'),
  estadoTitulo: document.getElementById('estado-titulo'),
  estadoDetalle: document.getElementById('estado-detalle'),
  estadoRun: document.getElementById('estado-run'),
  btnBuscar: document.getElementById('btn-buscar'),
  btnJson: document.getElementById('btn-json'),
  btnPdf: document.getElementById('btn-pdf'),
  selectFecha: document.getElementById('select-fecha'),
  statsResumen: document.getElementById('stats-resumen'),
  filtroTexto: document.getElementById('filtro-texto'),
  filtroNivel: document.getElementById('filtro-nivel'),
  resultados: document.getElementById('resultados'),
  sinResultados: document.getElementById('sin-resultados'),
  tplCard: document.getElementById('tpl-card')
};

const state = {
  fecha: null,
  licitaciones: [],
  nivel: 'TODAS',
  texto: '',
  repositorio: null
};

const rutaResultado = (fecha, ext) => `data/results/licitaciones-${fecha}.${ext}`;

function mostrarError(mensaje) {
  els.bannerError.textContent = `⚠️ ${mensaje}`;
  els.bannerError.hidden = false;
}

function ocultarError() {
  els.bannerError.hidden = true;
}

// ─── Carga de resultados guardados ────────────────────────────────────────────

async function cargarListaFechas(seleccionar) {
  try {
    const res = await fetch('data/manifest.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`No se encontró el índice de resultados (${res.status})`);
    const lista = await res.json();

    els.selectFecha.innerHTML = '';
    if (lista.length === 0) {
      els.selectFecha.innerHTML = '<option value="">Sin búsquedas todavía</option>';
      els.resultados.innerHTML = '';
      els.statsResumen.textContent = '';
      return;
    }

    for (const item of lista) {
      const opt = document.createElement('option');
      opt.value = item.fecha;
      opt.textContent = `${item.fecha} · ${item.total} resultado(s)`;
      els.selectFecha.appendChild(opt);
    }

    const fechaFinal = seleccionar && lista.some(l => l.fecha === seleccionar)
      ? seleccionar
      : lista[0].fecha;
    els.selectFecha.value = fechaFinal;
    await cargarFecha(fechaFinal);
  } catch (err) {
    mostrarError(`No se pudo cargar la lista de resultados: ${err.message}`);
  }
}

async function cargarFecha(fecha) {
  try {
    const res = await fetch(rutaResultado(fecha, 'json'), { cache: 'no-store' });
    if (!res.ok) throw new Error(`No se encontró el archivo de esa fecha (${res.status})`);
    state.fecha = fecha;
    state.licitaciones = await res.json();
    ocultarError();
    actualizarStats();
    renderizar();
  } catch (err) {
    mostrarError(`No se pudo cargar la búsqueda del ${fecha}: ${err.message}`);
  }
}

function actualizarStats() {
  const l = state.licitaciones;
  const alta = l.filter(x => x.nivel_relevancia === 'ALTA').length;
  const media = l.filter(x => x.nivel_relevancia === 'MEDIA').length;
  const baja = l.filter(x => x.nivel_relevancia === 'BAJA').length;
  els.statsResumen.innerHTML = `<b>${l.length}</b> total · <b>${alta}</b> alta · <b>${media}</b> media · <b>${baja}</b> baja`;
}

// ─── Render de tarjetas ────────────────────────────────────────────────────────

function renderizar() {
  const texto = state.texto.trim().toLowerCase();
  const filtradas = state.licitaciones.filter(l => {
    if (state.nivel !== 'TODAS' && l.nivel_relevancia !== state.nivel) return false;
    if (!texto) return true;
    const haystack = `${l.titulo} ${l.entidad} ${l.pais} ${l.portal}`.toLowerCase();
    return haystack.includes(texto);
  });

  els.resultados.innerHTML = '';
  els.sinResultados.hidden = filtradas.length > 0;

  for (const l of filtradas) {
    const nodo = els.tplCard.content.cloneNode(true);
    const nivel = (l.nivel_relevancia || 'BAJA').toLowerCase();

    const badge = nodo.querySelector('.badge');
    badge.textContent = l.nivel_relevancia || '—';
    badge.classList.add(`badge-${nivel}`);

    nodo.querySelector('.card-titulo').textContent = l.titulo;
    nodo.querySelector('.card-entidad').textContent =
      `${l.entidad}${l.region ? ' — ' + l.region : ''} · ${l.pais} · ${l.portal}`;

    const monto = l.monto_estimado
      ? `${l.moneda || ''} ${Number(l.monto_estimado).toLocaleString('es-CL')}`
      : 'Monto no publicado';
    const cierre = l.dias_hasta_cierre != null
      ? `${l.fecha_cierre} (faltan ${l.dias_hasta_cierre} días)`
      : (l.fecha_cierre || 'Sin fecha de cierre');
    nodo.querySelector('.card-montocierre').textContent = `💰 ${monto}  ·  📅 ${cierre}`;

    const razon = nodo.querySelector('.card-razon');
    if (l.razon_gemini) {
      razon.textContent = `🤖 ${l.razon_gemini}`;
    } else {
      razon.remove();
    }

    const link = nodo.querySelector('.card-link');
    link.href = l.url;

    els.resultados.appendChild(nodo);
  }
}

// ─── Filtros ───────────────────────────────────────────────────────────────

els.filtroTexto.addEventListener('input', (e) => {
  state.texto = e.target.value;
  renderizar();
});

els.filtroNivel.addEventListener('click', (e) => {
  const btn = e.target.closest('.pill');
  if (!btn) return;
  document.querySelectorAll('#filtro-nivel .pill').forEach(p => p.classList.remove('pill-active'));
  btn.classList.add('pill-active');
  state.nivel = btn.dataset.nivel;
  renderizar();
});

els.selectFecha.addEventListener('change', (e) => cargarFecha(e.target.value));

// ─── Descargas ─────────────────────────────────────────────────────────────

function descargar(ruta, nombre) {
  const a = document.createElement('a');
  a.href = ruta;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

els.btnJson.addEventListener('click', () => {
  if (!state.fecha) return;
  descargar(rutaResultado(state.fecha, 'json'), `licitaciones-${state.fecha}.json`);
});

els.btnPdf.addEventListener('click', () => {
  if (!state.fecha) return;
  descargar(rutaResultado(state.fecha, 'pdf'), `licitaciones-${state.fecha}.pdf`);
});

// ─── Estado de la última búsqueda ──────────────────────────────────────────
// Sin servidor no hay progreso en vivo: en su lugar se muestra el resultado de
// la última ejecución y, si el repositorio es público, se consulta la API de
// GitHub para avisar cuando hay una búsqueda corriendo en este momento.

const INTERVALO_SONDEO_MS = 20000;

function haceCuanto(iso) {
  const minutos = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutos < 1) return 'hace un momento';
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  return `hace ${Math.round(horas / 24)} días`;
}

function pintarEstado(estado) {
  els.panelEstado.hidden = false;

  const r = estado.resumen;
  els.estadoTitulo.textContent = r
    ? `✅ Última búsqueda ${haceCuanto(estado.ultima_ejecucion)} · ${r.nuevas} licitación(es) nueva(s)`
    : `⚠️ Última búsqueda ${haceCuanto(estado.ultima_ejecucion)} · sin resumen disponible`;

  const partes = [];
  if (r) {
    partes.push(`${r.portalesRevisados} portales revisados`);
    partes.push(`${r.totalAnalizadas} licitaciones analizadas`);
    partes.push(`${r.relevantes} relevantes`);
  }
  if (estado.errores?.length) partes.push(`${estado.errores.length} portal(es) con error`);
  els.estadoDetalle.textContent = partes.join(' · ');

  if (estado.run_url) {
    els.estadoRun.href = estado.run_url;
    els.estadoRun.hidden = false;
  }
}

async function cargarSitio() {
  try {
    const res = await fetch('data/sitio.json', { cache: 'no-store' });
    if (!res.ok) return;
    const sitio = await res.json();
    if (!sitio.repositorio) return;

    state.repositorio = sitio.repositorio;
    els.btnBuscar.href = `https://github.com/${sitio.repositorio}/actions/workflows/${sitio.workflow}`;
    els.btnBuscar.hidden = false;
  } catch {
    // En local no existe: el botón simplemente no se muestra
  }
}

async function cargarEstado() {
  try {
    const res = await fetch('data/estado.json', { cache: 'no-store' });
    if (!res.ok) return;
    pintarEstado(await res.json());
  } catch {
    // Sin estado.json el dashboard sigue funcionando: solo no muestra el panel
  }
}

async function sondearEjecucionEnCurso() {
  if (!state.repositorio) return;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${state.repositorio}/actions/runs?per_page=1`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) return; // repositorio privado o límite de la API: se ignora
    const ejecucion = (await res.json()).workflow_runs?.[0];
    if (!ejecucion) return;

    const enCurso = ejecucion.status === 'in_progress' || ejecucion.status === 'queued';
    if (enCurso) {
      els.panelEstado.hidden = false;
      els.estadoTitulo.textContent = '⏳ Búsqueda en curso…';
      els.estadoDetalle.textContent =
        `Iniciada ${haceCuanto(ejecucion.run_started_at)}. Esto tarda entre 10 y 20 minutos.`;
      els.estadoRun.href = ejecucion.html_url;
      els.estadoRun.hidden = false;
      setTimeout(sondearEjecucionEnCurso, INTERVALO_SONDEO_MS);
    } else if (els.estadoTitulo.textContent.startsWith('⏳')) {
      // Terminó mientras mirábamos: recargar los datos publicados
      await cargarEstado();
      await cargarListaFechas();
    }
  } catch {
    // La API de GitHub no es indispensable; el panel ya muestra el último estado
  }
}

// ─── Arranque ──────────────────────────────────────────────────────────────

(async () => {
  await Promise.all([cargarSitio(), cargarEstado()]);
  await cargarListaFechas();
  sondearEjecucionEnCurso();
})();

