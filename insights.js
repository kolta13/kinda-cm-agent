// ── Kinda CM Agent — Métricas y aprendizajes ─────────────────────────────
// Cierra el ciclo: el agente publica, mide qué funcionó, y alimenta esos
// hallazgos de vuelta al prompt de generación.
//
// Agnóstico a la fuente a propósito. Hoy TikTok no expone métricas (falta el
// scope video.list, que requiere una revisión nueva de la app) e Instagram
// necesita instagram_manage_insights. Mientras tanto se pueden cargar a mano:
//   node insights.js set <post_id> views=1200 likes=45 shares=12 comments=3 saves=30
//
// La normalización por vistas es deliberada: sin ella, un post que el algoritmo
// empujó por casualidad parece mejor que uno genuinamente bueno con menos
// alcance. Lo que queremos aprender es qué hace que la gente comparta y guarde,
// no cuál tuvo suerte de distribución.

'use strict';
const history = require('./history');

// Mínimo de posts por grupo para que un promedio signifique algo. Con 1 o 2
// muestras cualquier "aprendizaje" es superstición: un solo post viral por
// suerte haría que el sistema persiga ese formato para siempre.
const MIN_MUESTRA = 3;

// ── Registrar métricas ────────────────────────────────────────────────────

/**
 * Guarda las métricas de un post en el histórico.
 * @param {string} postId
 * @param {{views?:number, likes?:number, comments?:number, shares?:number, saves?:number}} datos
 * @param {string} fuente 'tiktok' | 'instagram' | 'manual'
 */
function setMetrics(postId, datos, fuente = 'manual') {
  const hist = history.load();
  const post = hist.posts.find(p => p.post_id === postId);
  if (!post) return false;

  post.metrics = {
    fuente,
    medido_el: new Date().toISOString(),
    views:    numOrNull(datos.views),
    likes:    numOrNull(datos.likes),
    comments: numOrNull(datos.comments),
    shares:   numOrNull(datos.shares),
    // saves no viene en la API de TikTok (video.list no lo expone) ni suele
    // estar disponible sin permisos extra en Meta. Se carga a mano desde
    // Analytics: para contenido educativo es la señal más valiosa que existe.
    saves:    numOrNull(datos.saves),
  };
  history.save(hist);
  return true;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Tasas derivadas ───────────────────────────────────────────────────────
// Todo normalizado por vistas. Un post con 12 shares en 400 vistas vale mucho
// más que uno con 30 shares en 50.000.

function tasas(m) {
  if (!m || !m.views) return null;
  const r = (x) => (x == null ? null : x / m.views);
  return {
    share:      r(m.shares),
    comment:    r(m.comments),
    save:       r(m.saves),
    engagement: r((m.likes || 0) + (m.comments || 0) + (m.shares || 0)),
  };
}

// ── Análisis ──────────────────────────────────────────────────────────────

/**
 * Agrupa los posts con métricas por una dimensión y devuelve el promedio de
 * cada tasa, descartando grupos con muestra insuficiente.
 */
function analizarPor(dimension, { minMuestra = MIN_MUESTRA, plataforma = null } = {}) {
  const posts = history.getAll().filter(p =>
    p.metrics && p.metrics.views && p[dimension] &&
    (!plataforma || p.platform === plataforma)
  );

  const grupos = {};
  for (const p of posts) {
    const clave = p[dimension];
    (grupos[clave] = grupos[clave] || []).push(tasas(p.metrics));
  }

  return Object.entries(grupos)
    .map(([clave, lista]) => ({
      valor:   clave,
      muestra: lista.length,
      share:      promedio(lista.map(t => t.share)),
      comment:    promedio(lista.map(t => t.comment)),
      save:       promedio(lista.map(t => t.save)),
      engagement: promedio(lista.map(t => t.engagement)),
    }))
    .filter(g => g.muestra >= minMuestra)
    .sort((a, b) => (b.share ?? 0) - (a.share ?? 0));
}

function promedio(valores) {
  const v = valores.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

// ── Aprendizajes para el prompt ───────────────────────────────────────────

/**
 * Texto compacto con lo que el rendimiento real sugiere, para inyectar en el
 * prompt de generación. Devuelve '' si todavía no hay datos suficientes —
 * preferible a inventar una conclusión que el sistema seguiría por semanas.
 */
function aprendizajes({ minMuestra = MIN_MUESTRA } = {}) {
  const lineas = [];

  for (const [dim, etiqueta] of [['formato', 'formato'], ['topic_tag', 'tema'], ['cta_mode', 'tipo de CTA']]) {
    const grupos = analizarPor(dim, { minMuestra });
    if (grupos.length < 2) continue; // sin al menos dos grupos no hay comparación

    const mejor = grupos[0];
    const peor  = grupos[grupos.length - 1];
    if (mejor.share == null || peor.share == null || mejor.share === 0) continue;

    const veces = peor.share > 0 ? (mejor.share / peor.share) : null;
    lineas.push(
      veces && veces >= 1.5
        ? `- Por ${etiqueta}: "${mejor.valor}" se comparte ${veces.toFixed(1)}x más que "${peor.valor}" (muestras: ${mejor.muestra} y ${peor.muestra}).`
        : `- Por ${etiqueta}: "${mejor.valor}" lidera en compartidos, sin diferencia grande con el resto.`
    );
  }

  if (lineas.length === 0) return '';

  return [
    'APRENDIZAJES DE RENDIMIENTO REAL (posts ya publicados):',
    ...lineas,
    'Usa esto como señal, no como regla rígida: el formato del día sigue mandando.',
  ].join('\n');
}

// ── Resumen para consola ──────────────────────────────────────────────────

function resumen() {
  const todos = history.getAll();
  const conMetricas = todos.filter(p => p.metrics && p.metrics.views);

  console.log(`Posts en histórico: ${todos.length} | con métricas: ${conMetricas.length}`);
  if (conMetricas.length === 0) {
    console.log('\nAún no hay métricas cargadas. Para cargar una a mano:');
    console.log('  node insights.js set <post_id> views=1200 likes=45 shares=12 comments=3 saves=30');
    return;
  }

  for (const [dim, etiqueta] of [['formato', 'FORMATO'], ['topic_tag', 'TEMA'], ['cta_mode', 'CTA']]) {
    const grupos = analizarPor(dim, { minMuestra: 1 });
    if (grupos.length === 0) continue;
    console.log(`\n=== POR ${etiqueta} ===`);
    grupos.forEach(g => {
      const pct = (x) => (x == null ? '   —  ' : (x * 100).toFixed(2) + '%');
      const aviso = g.muestra < MIN_MUESTRA ? '  ⚠ muestra chica' : '';
      console.log(`  ${String(g.valor).padEnd(26)} n=${g.muestra}  share ${pct(g.share)}  save ${pct(g.save)}  eng ${pct(g.engagement)}${aviso}`);
    });
  }

  const texto = aprendizajes();
  console.log('\n=== LO QUE SE INYECTARÍA AL PROMPT ===');
  console.log(texto || '(nada todavía — hace falta más muestra por grupo)');
}

// ── Carga interactiva ─────────────────────────────────────────────────────
// Los guardados no están en la API (ni en TikTok ni en Meta sin permisos
// extra) y scrapear TikTok choca contra su WAF, así que la vía realista es
// mirarlos en Analytics. Esto evita tener que copiar post_ids a mano.

function postsSinMetricas(plataforma = null) {
  return history.getAll().filter(p =>
    (!p.metrics || !p.metrics.views) && (!plataforma || p.platform === plataforma)
  );
}

async function capturar(plataforma = null) {
  const readline = require('readline');
  const pendientes = postsSinMetricas(plataforma);

  if (pendientes.length === 0) {
    console.log('No hay posts sin métricas. Todo al día.');
    return;
  }

  console.log(`${pendientes.length} post(s) sin métricas.`);
  console.log('Enter vacío salta el post. Enter en un campo lo deja sin dato.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const preguntar = (q) => new Promise(res => rl.question(q, res));

  let guardados = 0;
  for (const p of pendientes) {
    console.log('─'.repeat(64));
    console.log(`${p.published_at.slice(0, 10)}  [${p.platform}]  ${p.tema.slice(0, 52)}`);
    console.log(`formato: ${p.formato || '—'}   tema: ${p.topic_tag || '—'}   cta: ${p.cta_mode || '—'}`);

    const views = (await preguntar('  vistas (Enter salta este post): ')).trim();
    if (!views) { console.log('  saltado\n'); continue; }

    const datos = { views };
    for (const campo of ['likes', 'comments', 'shares', 'saves']) {
      datos[campo] = (await preguntar(`  ${campo}: `)).trim();
    }

    setMetrics(p.post_id, datos, 'manual');
    guardados++;
    console.log('  ✓ guardado\n');
  }

  rl.close();
  console.log(`${guardados} post(s) actualizado(s).`);
  if (guardados > 0) console.log('Corre "node insights.js" para ver el análisis.');
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'set') {
    const postId = args[0];
    if (!postId) {
      console.error('Uso: node insights.js set <post_id> views=1200 shares=12 saves=30');
      process.exit(1);
    }
    const datos = {};
    args.slice(1).forEach(par => {
      const [k, v] = par.split('=');
      if (k && v !== undefined) datos[k] = v;
    });
    const ok = setMetrics(postId, datos, 'manual');
    console.log(ok ? `✓ Métricas guardadas para ${postId}` : `✗ No existe un post con post_id ${postId}`);
    if (!ok) process.exit(1);

  } else if (cmd === 'capturar') {
    // Opcional: filtrar por plataforma → node insights.js capturar tiktok
    capturar(args[0] || null).catch(e => { console.error('Error:', e.message); process.exit(1); });

  } else if (cmd === 'pendientes') {
    const p = postsSinMetricas(args[0] || null);
    console.log(`${p.length} post(s) sin métricas:`);
    p.forEach(x => console.log(`  ${x.published_at.slice(0,10)} [${x.platform}] ${x.tema.slice(0,55)}`));

  } else {
    resumen();
  }
}

module.exports = { setMetrics, analizarPor, aprendizajes, tasas };
