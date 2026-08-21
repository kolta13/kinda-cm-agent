// ── Kinda CM Agent — Fase 3: Render de slides ──────────────────────────
// Toma carousel_latest.json y genera 7 PNGs con el branding de Kinda Club.
// Output: output/semana-{N}/slide-01.png ... slide-07.png
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

// Estilos visuales que rotan día a día para máxima variedad entre posts
const PEXELS_QUERY_STYLES = [
  'music producer studio headphones dark moody',
  'concert stage performance lights crowd',
  'urban street hip-hop culture graffiti',
  'recording studio microphone professional',
  'musician portrait dark dramatic lighting',
  'music festival outdoor performance energy',
  'dj producer nightclub performance dark',
];

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

async function fetchCoverImages(tema, count) {
  if (!config.pexelsApiKey) return [];

  const usedIds = loadUsedPhotoIds();

  // Rotar estilo visual según el día (evita que posts consecutivos tengan la misma estética)
  const dayIndex   = Math.floor(Date.now() / 86400000);
  const styleQuery = PEXELS_QUERY_STYLES[dayIndex % PEXELS_QUERY_STYLES.length];

  // Página aleatoria determinista por día (1-4) para obtener fotos distintas cada vez
  const page = (dayIndex % 4) + 1;

  // Pedir 3x más fotos de las necesarias para tener opciones al filtrar usadas
  const perPage = Math.min(count * 3, 30);
  const query   = encodeURIComponent(styleQuery);
  const apiUrl  = `https://api.pexels.com/v1/search?query=${query}&orientation=portrait&size=large&per_page=${perPage}&page=${page}`;

  try {
    const raw  = await httpGet(apiUrl, { Authorization: config.pexelsApiKey });
    const data = JSON.parse(raw.toString());
    if (!data.photos || data.photos.length === 0) return [];

    // Filtrar fotos ya usadas; si no hay suficientes sin usar, usar las disponibles
    const fresh   = data.photos.filter(p => !usedIds.has(String(p.id)));
    const toUse   = (fresh.length >= count ? fresh : data.photos).slice(0, count);

    console.log(`[render] Pexels: ${data.photos.length} fotos, ${fresh.length} nuevas, usando ${toUse.length} (estilo: "${styleQuery}", pág ${page})`);

    // Descargar en paralelo
    const results = await Promise.all(
      toUse.map(async (photo, i) => {
        const imgUrl = photo.src.large2x || photo.src.large;
        console.log(`  foto ${i + 1}: "${photo.photographer}" — id ${photo.id}`);
        const buf = await httpGet(imgUrl, {});
        return { base64: 'data:image/jpeg;base64,' + buf.toString('base64'), id: photo.id };
      })
    );

    // Guardar IDs usados para evitarlos en futuras runs
    saveUsedPhotoIds(usedIds, results.map(r => String(r.id)));

    return results.map(r => r.base64);
  } catch (e) {
    console.warn('[render] Pexels falló, slides sin imagen:', e.message);
    return [];
  }
}

function logoBase64(file) {
  const p = path.join(ASSETS_DIR, file);
  if (!fs.existsSync(p)) return '';
  return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
}

// ── Adaptar carousel JSON al formato del template ──────────────────────

function buildSlideData(carousel) {
  const slides    = carousel.slides;
  const portada   = slides.find(s => s.tipo === 'portada');
  const contenidos = slides.filter(s => s.tipo === 'contenido');
  const cta       = slides.find(s => s.tipo === 'cta');

  return {
    kicker:    'Kinda Club · Para músicos',
    portada: {
      titulo:    portada?.titulo   || '',
      subtitulo: portada?.subtitulo || '',
    },
    contenidos: contenidos.map((s, i) => ({
      label: `${i + 1}`,
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
  const slideData = buildSlideData(carousel);
  const outDir    = path.join(OUT_BASE, `semana-${week}`);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Buscar una foto distinta por slide desde Pexels (cantidad dinámica)
  const totalSlides = slideData.contenidos.length + 2; // portada + contenidos + cta
  const coverImages = await fetchCoverImages(carousel.tema, totalSlides);

  console.log('[render] Iniciando Puppeteer...');
  const browser = await puppeteer.launch({
    headless:  true,
    args:      ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: SIZE_W, height: SIZE_H, deviceScaleFactor: 2 });

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
    { id: 'slide-portada', label: 'Portada', file: 'slide-01.png' },
    ...slideData.contenidos.map((_, i) => ({
      id:    `slide-${i + 1}`,
      label: `${i + 1}`,
      file:  `slide-${String(i + 2).padStart(2, '0')}.png`,
    })),
    { id: 'slide-cta', label: 'CTA', file: `slide-${String(contenidosCount + 2).padStart(2, '0')}.png` },
  ];

  const paths = [];
  for (const def of slideDefs) {
    await page.evaluate((id) => { window.showSlide(id); }, def.id);
    // Pequeña pausa para que el render de fuentes y gradientes termine
    await new Promise(r => setTimeout(r, 120));

    const outPath = path.join(outDir, def.file);
    await page.screenshot({ path: outPath, type: 'png', clip: { x: 0, y: 0, width: SIZE_W, height: SIZE_H } });
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
