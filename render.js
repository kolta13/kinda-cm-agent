// ── Kinda CM Agent — Fase 3: Render de slides ──────────────────────────
// Toma carousel_latest.json y genera JPGs con el branding de Kinda Club.
// JPG (no PNG): TikTok Content Posting API rechaza PNG en fotos con
// file_format_check_failed — solo acepta JPEG/WEBP. Meta acepta ambos,
// así que se unificó a JPEG para servir el mismo archivo a las dos plataformas.
// Output: output/semana-{N}/slide-01.jpg ... slide-07.jpg
//
// Uso: node render.js

'use strict';
const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const config    = require('./config');

const TEMPLATE    = path.join(__dirname, 'template', 'slide.html');
const DATA_DIR    = path.join(__dirname, 'data');
const OUT_BASE    = path.join(__dirname, 'output');
const ASSETS_DIR  = path.join(__dirname, 'assets');
const SIZE_W      = 1080;
const SIZE_H      = 1350;

// ── Pexels: buscar y descargar imagen de portada ───────────────────────

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + (parsed.search || ''),
      method:   'GET',
      headers:  { 'User-Agent': 'KindaCMAgent/1.0', ...headers },
      timeout:  15000,
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Estilos visuales genéricos — fallback cuando el texto del slide no matchea
// ningún tema conocido. Rotan día a día para variedad entre posts.
// Evitar keywords como "crowd"/"festival" en queries: traen fotos con pancartas,
// carteles o señalética real de eventos/clubes que se alcanza a leer bajo el
// overlay (ej. nombre de un festival o discoteca real quedando visible en el post).
// Se prefieren planos más cerrados: siluetas, luces de escenario, primeros planos.
const PEXELS_QUERY_STYLES = [
  'music producer studio headphones dark moody',
  'concert stage lights silhouette dark',
  'urban street hip-hop culture graffiti',
  'recording studio microphone professional',
  'musician portrait dark dramatic lighting',
  'stage lights smoke silhouette night',
  'dj producer nightclub performance dark',
];

// Mapea keywords del titulo/body de CADA slide a un query de Pexels específico,
// para que la imagen se relacione con el contenido real de esa slide en vez de
// ser genérica para todo el carrusel.
// Los posts manuales que mejor funcionaron usaban capturas reales de plataformas
// (dashboard de Spotify for Artists, calendario del teléfono). No podemos generar
// capturas reales, así que sesgamos hacia fotos de pantallas y dispositivos.
//
// CUIDADO (aprendido a la mala): un query de pantalla genérico como "financial
// data screen analytics" devuelve capturas de exchanges de cripto con tickers y
// marcas legibles — irrelevante para música y peor que una foto abstracta.
// TODA query de pantalla debe llevar un ancla de música ("music", "audio",
// "recording") para que Pexels no se vaya a finanzas, trading o negocios genéricos.
const TOPIC_IMAGE_QUERIES = [
  { keywords: ['estudio', 'grabaci', 'mezcla', 'masteriz', 'produc'],                  query: 'music production software daw screen studio' },
  { keywords: ['spotify', 'streaming', 'playlist', 'algoritmo'],                       query: 'music streaming app phone listening headphones' },
  { keywords: ['dato', 'métrica', 'metrica', 'analítica', 'analitica', 'estadístic', 'oyentes', 'audiencia'], query: 'music producer laptop headphones desk dark' },
  { keywords: ['concierto', 'show', 'gira', 'festival', 'presentaci', 'escenario'],    query: 'live concert stage lights silhouette' },
  { keywords: ['contrato', 'sello', 'manager', 'negoci', 'acuerdo', 'label', 'cláusul', 'clausul'], query: 'signing document pen paper desk closeup' },
  { keywords: ['redes', 'contenido', 'fanbase', 'engagement', 'instagram', 'reel'],    query: 'musician filming phone content social media' },
  { keywords: ['tiktok', 'video', 'viral', 'shorts'],                                  query: 'filming vertical video phone content creator' },
  { keywords: ['dinero', 'royalt', 'ingres', 'gana', 'pago', 'cobr', 'tarifa', 'sync'], query: 'musician counting money guitar desk dark' },
  { keywords: ['calendario', 'fecha', 'plazo', 'cronograma', 'planifica'],             query: 'calendar planner notebook desk music' },
  { keywords: ['micrófono', 'microfono', 'vocal', 'cantar', 'voz', 'cantante'],        query: 'singer vocalist microphone studio' },
  { keywords: ['dj', 'beat', 'plugin', 'daw', 'software', 'herramienta'],              query: 'music producer studio equipment dark' },
  { keywords: ['booking', 'evento', 'merch'],                                          query: 'concert booking event merchandise' },
  { keywords: ['colabo', 'equipo', 'networking', 'profesional'],                       query: 'musicians collaborating studio session' },
  { keywords: ['portafolio', 'demo', 'proyecto'],                                      query: 'music producer laptop portfolio work' },
];

function resolveQueryForSlide(titulo, body) {
  const text = ((titulo || '') + ' ' + (body || '')).toLowerCase();
  const match = TOPIC_IMAGE_QUERIES.find(({ keywords }) => keywords.some(kw => text.includes(kw)));
  return match ? match.query : null;
}

// IDs de fotos usadas recientemente (persiste entre runs via git)
const PEXELS_USED_PATH = path.join(path.join(__dirname, 'data'), 'pexels_used.json');

function loadUsedPhotoIds() {
  try {
    if (fs.existsSync(PEXELS_USED_PATH)) {
      return new Set(JSON.parse(fs.readFileSync(PEXELS_USED_PATH, 'utf8')));
    }
  } catch (_) {}
  return new Set();
}

function saveUsedPhotoIds(usedSet, newIds) {
  const merged = [...usedSet, ...newIds].slice(-150); // conservar últimas 150 IDs (~3-4 semanas)
  try { fs.writeFileSync(PEXELS_USED_PATH, JSON.stringify(merged), 'utf8'); } catch (_) {}
}

// Busca una imagen relevante POR SLIDE según su propio titulo/body.
// slideTexts: [{titulo, body}, ...] en el mismo orden en que se inyectan a .cover-img.
async function fetchSlideImages(slideTexts) {
  if (!config.pexelsApiKey) return [];

  const usedIds  = loadUsedPhotoIds();
  const dayIndex = Math.floor(Date.now() / 86400000);
  const dayStyle = PEXELS_QUERY_STYLES[dayIndex % PEXELS_QUERY_STYLES.length];
  const page     = (dayIndex % 4) + 1;

  const resolvedQueries = slideTexts.map(s => resolveQueryForSlide(s.titulo, s.body) || dayStyle);

  // Agrupar slides por query para minimizar llamadas a Pexels (una por query única)
  const groups = new Map();
  resolvedQueries.forEach((q, i) => {
    if (!groups.has(q)) groups.set(q, []);
    groups.get(q).push(i);
  });

  const images       = new Array(slideTexts.length).fill(null);
  const newlyUsedIds = [];

  for (const [query, indices] of groups) {
    const count   = indices.length;
    const perPage = Math.min(count * 3, 30);
    const apiUrl  = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&size=large&per_page=${perPage}&page=${page}`;

    try {
      const raw   = await httpGet(apiUrl, { Authorization: config.pexelsApiKey });
      const data  = JSON.parse(raw.toString());
      const photos = data.photos || [];
      const fresh  = photos.filter(p => !usedIds.has(String(p.id)));
      const toUse  = (fresh.length >= count ? fresh : photos).slice(0, count);

      console.log(`[render] "${query}" → ${photos.length} fotos, usando ${toUse.length} para ${count} slide(s)`);

      const downloaded = await Promise.all(
        toUse.map(async (photo) => {
          const imgUrl = photo.src.large2x || photo.src.large;
          const buf    = await httpGet(imgUrl, {});
          return { base64: 'data:image/jpeg;base64,' + buf.toString('base64'), id: photo.id };
        })
      );

      downloaded.forEach((d, j) => {
        const slideIndex = indices[j];
        if (slideIndex !== undefined) {
          images[slideIndex] = d.base64;
          newlyUsedIds.push(String(d.id));
        }
      });
    } catch (e) {
      console.warn(`[render] Pexels falló para "${query}":`, e.message);
    }
  }

  saveUsedPhotoIds(usedIds, newlyUsedIds);

  // Si alguna query específica no trajo resultado, usar la primera imagen exitosa como fallback
  const fallback = images.find(Boolean) || '';
  return images.map(img => img || fallback);
}

function logoBase64(file) {
  const p = path.join(ASSETS_DIR, file);
  if (!fs.existsSync(p)) return '';
  return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
}

// ── Badge de la portada (categoría + color rotativo) ────────────────────

const TOPIC_BADGE_LABELS = {
  monetizacion: 'MONETIZACIÓN',
  distribucion: 'DISTRIBUCIÓN',
  marketing:    'MARKETING MUSICAL',
  video_viral:  'REDES Y VIRAL',
  shows:        'SHOWS Y GIRAS',
  networking:   'KINDA CLUB',
  tecnologia:   'HERRAMIENTAS',
  noticias:     'INDUSTRIA MUSICAL',
  general:      'KINDA CLUB',
};

// Naranjo (ember) y violeta (accent) de la paleta — alternan día por medio
const BADGE_COLORS = ['#ff2400', '#4100f5'];

// El kicker que genera Gemini es específico del tema ("SPOTIFY 101",
// "SPOTIFY x META ADS") y funciona mucho mejor que la categoría genérica.
// TOPIC_BADGE_LABELS queda solo como respaldo si el modelo no devolvió kicker.
function resolveBadgeLabel(kicker, topicTag, audienceType) {
  if (kicker && String(kicker).trim()) return String(kicker).trim().toUpperCase();
  return TOPIC_BADGE_LABELS[topicTag]
    || (audienceType === 'profesional' ? 'PARA PROFESIONALES' : 'ARTISTAS INDEPENDIENTES');
}

function resolveBadgeColor() {
  const dayIndex = Math.floor(Date.now() / 86400000);
  return BADGE_COLORS[dayIndex % 2];
}

// ── Adaptar carousel JSON al formato del template ──────────────────────

function buildSlideData(carousel, meta = {}) {
  const slides    = carousel.slides;
  const portada   = slides.find(s => s.tipo === 'portada');
  const contenidos = slides.filter(s => s.tipo === 'contenido');
  const cta       = slides.find(s => s.tipo === 'cta');

  return {
    kicker:    'Kinda Club · Para músicos',
    portada: {
      titulo:      portada?.titulo   || '',
      subtitulo:   portada?.subtitulo || '',
      badge:       resolveBadgeLabel(portada?.kicker, meta.topic_tag, meta.audience_type),
      badgeColor:  resolveBadgeColor(),
      // Contador visible desde la portada (1/N): los posts manuales que mejor
      // funcionaron lo mostraban ahí — le dice al lector cuánto dura antes de empezar.
      counter:     `1 / ${slides.length}`,
    },
    contenidos: contenidos.map((s) => ({
      // Sin número suelto: el título ya trae la etiqueta estructural ("ERROR 1:",
      // "ANTES:", "PASO 2:") y arriba a la derecha está el contador X/N. Un tercer
      // número era redundante y ensuciaba — los posts manuales tampoco lo tenían.
      label: '',
      titulo: cleanTitle(s.titulo),
      body:   s.body || '',
    })),
    cta: {
      titulo: cta?.titulo || '¿Eres músico independiente?',
      body:   cta?.body   || 'Conecta con artistas, managers y productores de LATAM.',
    },
  };
}

// Limpiar numeración automática del título ("1. Streaming" → "Streaming")
function cleanTitle(t) {
  return (t || '').replace(/^\d+\.\s*/, '').trim();
}

// ── Render ─────────────────────────────────────────────────────────────

async function renderSlides(carousel, week, data = {}) {
  const slideData = buildSlideData(carousel, {
    topic_tag:     data.topic_tag,
    audience_type: carousel.audience_type,
  });
  const outDir    = path.join(OUT_BASE, `semana-${week}`);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Buscar una foto RELEVANTE AL CONTENIDO de cada slide (mismo orden que
  // los elementos .cover-img en el DOM: portada, contenidos..., cta).
  const slideTextsInOrder = [
    { titulo: slideData.portada.titulo, body: slideData.portada.subtitulo },
    ...slideData.contenidos.map(c => ({ titulo: c.titulo, body: c.body })),
    { titulo: slideData.cta.titulo, body: slideData.cta.body },
  ];
  const coverImages = await fetchSlideImages(slideTextsInOrder);

  console.log('[render] Iniciando Puppeteer...');
  const browser = await puppeteer.launch({
    headless:  true,
    args:      ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });

  const page = await browser.newPage();
  // deviceScaleFactor 1 (antes 2): a 2160×2700 (factor 2) TikTok rechazaba las
  // fotos con picture_size_check_failed. 1080×1350 nativo funciona en TikTok Y
  // es exactamente la resolución que Instagram recomienda para posts 4:5 — no
  // se pierde calidad real, además reduce el peso de archivo casi 10x.
  await page.setViewport({ width: SIZE_W, height: SIZE_H, deviceScaleFactor: 1 });

  const templateUrl = 'file:///' + TEMPLATE.replace(/\\/g, '/');
  await page.goto(templateUrl, { waitUntil: 'networkidle0', timeout: 30000 });

  // Inyectar logos reales
  const logoInline  = logoBase64('logo-inline.png');
  const logoStacked = logoBase64('logo-stacked.png');
  await page.evaluate(({ inline, stacked }) => {
    document.querySelectorAll('#logo-wm').forEach(el => { el.src = inline; });
    const ctaImg = document.getElementById('logo-cta');
    if (ctaImg) ctaImg.src = inline;
  }, { inline: logoInline, stacked: logoStacked });

  // Inyectar una foto distinta por slide (en orden: portada, puntos 1-5, cta)
  if (coverImages.length > 0) {
    await page.evaluate((srcs) => {
      document.querySelectorAll('.cover-img').forEach((el, i) => {
        el.src = srcs[i % srcs.length];
      });
    }, coverImages);
  }

  // Inyectar datos en el template
  await page.evaluate((data) => { window.fillSlide(data); }, slideData);

  // Definir qué slides renderizar según los slides generados (dinámico 3-8)
  const contenidosCount = slideData.contenidos.length; // 1-6
  const slideDefs = [
    { id: 'slide-portada', label: 'Portada', file: 'slide-01.jpg' },
    ...slideData.contenidos.map((_, i) => ({
      id:    `slide-${i + 1}`,
      label: `${i + 1}`,
      file:  `slide-${String(i + 2).padStart(2, '0')}.jpg`,
    })),
    { id: 'slide-cta', label: 'CTA', file: `slide-${String(contenidosCount + 2).padStart(2, '0')}.jpg` },
  ];

  const paths = [];
  for (const def of slideDefs) {
    await page.evaluate((id) => { window.showSlide(id); }, def.id);
    // Pequeña pausa para que el render de fuentes y gradientes termine
    await new Promise(r => setTimeout(r, 120));

    const outPath = path.join(outDir, def.file);
    await page.screenshot({ path: outPath, type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: SIZE_W, height: SIZE_H } });
    paths.push(outPath);
    console.log(`  ✓ ${def.label} → ${def.file}`);
  }

  await browser.close();

  // Guardar manifiesto para que publish.js sepa qué subir
  const manifest = {
    generated_at: new Date().toISOString(),
    week,
    tema:         carousel.tema,
    backlog_id:   data.backlog_id || null,
    outDir,
    slides:       slideDefs.map((d, i) => ({ label: d.label, file: d.file, path: paths[i] })),
    caption:      carousel.caption_instagram,
    hashtags:     carousel.hashtags,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'render_latest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`\n[render] ✅ 7 slides en ${outDir}`);
  return manifest;
}

// ── Main ───────────────────────────────────────────────────────────────

async function render() {
  const carouselPath = path.join(DATA_DIR, 'carousel_latest.json');
  if (!fs.existsSync(carouselPath)) {
    console.error('[render] No existe carousel_latest.json — corre generate.js primero');
    process.exit(1);
  }

  const data     = JSON.parse(fs.readFileSync(carouselPath, 'utf8'));
  const carousel = data.carousel;
  const week     = data.week;

  console.log(`[render] ${week}: "${carousel.tema}"`);
  return await renderSlides(carousel, week, data);
}

if (require.main === module) {
  render().catch(e => { console.error('[render] Error fatal:', e); process.exit(1); });
}

module.exports = { render };
