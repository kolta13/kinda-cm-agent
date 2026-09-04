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
    (grupos[clave] = grupos[clave] || []).push(p);
  }

  return Object.entries(grupos)
    .map(([clave, lista]) => {
      const t = lista.map(p => tasas(p.metrics));
      return {
        valor:   clave,
        muestra: lista.length,
        // Tasas: densidad de resonancia en quien vio el post.
        share:      promedio(t.map(x => x.share)),
        comment:    promedio(t.map(x => x.comment)),
        save:       promedio(t.map(x => x.save)),
        engagement: promedio(t.map(x => x.engagement)),
        // Absolutos: alcance × resonancia. Se guardan porque las tasas solas
        // engañan — ver comentario en aprendizajes().
        sharesAbs:  promedio(lista.map(p => p.metrics.shares)),
        savesAbs:   promedio(lista.map(p => p.metrics.saves)),
        viewsAbs:   promedio(lista.map(p => p.metrics.views)),
      };
    })
    .filter(g => g.muestra >= minMuestra)
    .sort((a, b) => (b.share ?? 0) - (a.share ?? 0));
}

function promedio(valores) {
  const v = valores.filter(x => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

// ── Ranking de posts por rendimiento ──────────────────────────────────────
// El copy no se puede promediar: no existe "el hook promedio". Pero sí se le
// puede mostrar a Gemini el copy real de los que funcionaron y los que no, para
// que infiera el patrón — que es algo que un modelo hace mejor que cualquier
// métrica que definamos a mano.
//
// Para ordenarlos se suman los dos rankings (Borda): posición por tasa de
// compartido + posición por compartidos absolutos. Así ninguna de las dos
// señales manda sola, que es justo el problema de la dilución por viralidad.

function rankear(plataforma = null) {
  const posts = history.getAll().filter(p =>
    p.metrics && p.metrics.views && p.slides &&
    (!plataforma || p.platform === plataforma)
  );
  if (posts.length < 2) return [];

  const porTasa = [...posts].sort((a, b) => (tasas(b.metrics).share ?? 0) - (tasas(a.metrics).share ?? 0));
  const porAbs  = [...posts].sort((a, b) => (b.metrics.shares ?? 0) - (a.metrics.shares ?? 0));

  return posts
    .map(p => ({
      post:  p,
      score: porTasa.indexOf(p) + porAbs.indexOf(p), // menor = mejor
    }))
    .sort((a, b) => a.score - b.score)
    .map(x => x.post);
}

// Resume un post a lo que importa para aprender de su estructura: el hook, el
// arco de títulos y el caption. Los bodies se omiten a propósito — triplicarían
// el tamaño del prompt y lo que se quiere enseñar acá es la forma, no el dato.
function resumirCopy(p) {
  const t = tasas(p.metrics);
  const portada = (p.slides.find(s => s.tipo === 'portada') || {}).titulo || '—';
  const arco = p.slides
    .filter(s => s.tipo === 'contenido')
    .map(s => s.titulo)
    .join(' → ');
  const cta = (p.slides.find(s => s.tipo === 'cta') || {}).titulo || '—';

  const pct = t.share != null ? (t.share * 100).toFixed(2) + '%' : '—';
  return [
    `  HOOK: "${portada}"`,
    `  ARCO: ${arco || '—'}`,
    `  CIERRE: ${cta}`,
    `  CAPTION: ${(p.caption || '').split('\n')[0]}`,
    `  (formato ${p.formato || '—'} · ${p.metrics.shares ?? '—'} compartidos · tasa ${pct} · ${p.metrics.views} vistas)`,
  ].join('\n');
}

/**
 * Bloque con el copy real de los mejores y peores posts, para que el modelo
 * infiera qué estructura y qué tipo de hook funcionan.
 */
function ejemplosDeCopy({ mejores = 3, peores = 2, plataforma = null } = {}) {
  const ranking = rankear(plataforma);
  // Con menos de 5 posts medidos no hay contraste real: los "peores" serían
  // simplemente los segundos mejores y el modelo aprendería una distinción falsa.
  if (ranking.length < 5) return '';

  const top    = ranking.slice(0, mejores);
  const bottom = ranking.slice(-peores);

  return [
    'COPY QUE FUNCIONÓ (posts reales de esta cuenta, ordenados por rendimiento):',
    top.map((p, i) => `${i + 1}.\n${resumirCopy(p)}`).join('\n\n'),
    '',
    'COPY QUE NO FUNCIONÓ:',
    bottom.map((p, i) => `${i + 1}.\n${resumirCopy(p)}`).join('\n\n'),
    '',
    'Fíjate en QUÉ hace distinto al primer grupo: el tipo de hook, cómo avanza el',
    'arco de títulos, qué tan concreto es el cierre. Aplica ese patrón al carrusel',
    'de hoy sin copiar los temas ni las frases.',
  ].join('\n');
}

// ── Aprendizajes para el prompt ───────────────────────────────────────────

/**
 * Texto compacto con lo que el rendimiento real sugiere, para inyectar en el
 * prompt de generación. Devuelve '' si todavía no hay datos suficientes —
 * preferible a inventar una conclusión que el sistema seguiría por semanas.
 */
// Las tasas solas engañan: cuando un post se viraliza, TikTok lo saca del núcleo
// de audiencia y lo empuja a gente menos afín, que engagea menos. El denominador
// crece con tráfico de peor calidad y la tasa CAE aunque el contenido sea mejor.
// Peor aún: en TikTok el alcance ES el veredicto del algoritmo (muestra a un lote
// chico, mide, expande si funciona), así que dividir por vistas es dividir por la
// señal que queríamos medir.
//
// Los absolutos tienen el sesgo opuesto: premian suerte de timing.
//
// Por eso se miran las dos y solo se afirma cuando COINCIDEN. Si se contradicen,
// se dice explícitamente — con 10-20 posts, una conclusión falsamente segura es
// peor que admitir la ambigüedad, porque el sistema la seguiría por semanas.
function aprendizajes({ minMuestra = MIN_MUESTRA } = {}) {
  const lineas = [];

  for (const [dim, etiqueta] of [['formato', 'formato'], ['topic_tag', 'tema'], ['cta_mode', 'tipo de CTA']]) {
    const grupos = analizarPor(dim, { minMuestra });
    if (grupos.length < 2) continue; // sin al menos dos grupos no hay comparación

    // grupos ya viene ordenado por tasa de compartido
    const mejorTasa = grupos[0];
    const peorTasa  = grupos[grupos.length - 1];
    if (mejorTasa.share == null || peorTasa.share == null || peorTasa.share === 0) continue;

    // El mismo ranking, pero por compartidos absolutos
    const porAbs    = [...grupos].sort((a, b) => (b.sharesAbs ?? 0) - (a.sharesAbs ?? 0));
    const mejorAbs  = porAbs[0];

    const vecesTasa = mejorTasa.share / peorTasa.share;

    if (mejorAbs.valor === mejorTasa.valor) {
      // Ambas señales apuntan al mismo grupo: conclusión sólida.
      lineas.push(vecesTasa >= 1.5
        ? `- Por ${etiqueta}: "${mejorTasa.valor}" gana en tasa Y en volumen de compartidos (${vecesTasa.toFixed(1)}x sobre "${peorTasa.valor}"; muestras: ${mejorTasa.muestra} y ${peorTasa.muestra}).`
        : `- Por ${etiqueta}: "${mejorTasa.valor}" lidera en tasa y volumen, pero sin diferencia grande.`);
    } else {
      // Se contradicen: casi siempre significa que el líder por volumen se
      // viralizó (más alcance, tasa diluida). No hay ganador claro.
      lineas.push(`- Por ${etiqueta}: señales cruzadas — "${mejorTasa.valor}" tiene mejor tasa de compartido, pero "${mejorAbs.valor}" consigue más compartidos totales (probable mayor alcance). Sin ganador claro todavía.`);
    }
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
      const pct = (x) => (x == null ? '  — ' : (x * 100).toFixed(2) + '%');
      const num = (x) => (x == null ? ' —' : Math.round(x).toLocaleString('es'));
      const aviso = g.muestra < MIN_MUESTRA ? '  ⚠ muestra chica' : '';
      // Tasa y absoluto lado a lado: si se contradicen, casi siempre es que el
      // de más volumen se viralizó y diluyó su tasa.
      console.log(`  ${String(g.valor).padEnd(26)} n=${g.muestra}  tasa ${pct(g.share)}  |  compart. ${String(num(g.sharesAbs)).padStart(6)}  vistas ${String(num(g.viewsAbs)).padStart(7)}${aviso}`);
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

module.exports = { setMetrics, analizarPor, aprendizajes, ejemplosDeCopy, rankear, tasas };
