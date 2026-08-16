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

async function fetchCoverImages(tema, count) {
  if (!config.pexelsApiKey) return [];

  const keywords = tema
    .replace(/[¡!¿?.,"]/g, ' ')
    .split(' ')
    .filter(w => w.length > 3)
    .slice(0, 2)
    .join(' ');

  // Estética urbana/trap/r&b como base del query
  const query  = encodeURIComponent(`urban hip-hop r&b music artist ${keywords}`);
  const apiUrl = `https://api.pexels.com/v1/search?query=${query}&orientation=portrait&size=large&per_page=${count}`;

  try {
    const raw  = await httpGet(apiUrl, { Authorization: config.pexelsApiKey });
    const data = JSON.parse(raw.toString());
    if (!data.photos || data.photos.length === 0) return [];

    console.log(`[render] ${data.photos.length} fotos Pexels obtenidas`);

    // Descargar todas en paralelo
    const results = await Promise.all(
      data.photos.slice(0, count).map(async (photo, i) => {
        const imgUrl = photo.src.large2x || photo.src.large;
        console.log(`  foto ${i + 1}: "${photo.photographer}" → ${photo.src.medium}`);
        const buf = await httpGet(imgUrl, {});
        return 'data:image/jpeg;base64,' + buf.toString('base64');
      })
    );
    return results;
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
      label: `Punto ${i + 1}`,
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

  // Buscar una foto distinta por slide desde Pexels (7 slides total)
  const coverImages = await fetchCoverImages(carousel.tema, 7);

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

  // Definir qué slides renderizar y en qué orden
  const slideDefs = [
    { id: 'slide-portada', label: 'Portada',    file: 'slide-01.png' },
    { id: 'slide-1',       label: 'Punto 1',    file: 'slide-02.png' },
    { id: 'slide-2',       label: 'Punto 2',    file: 'slide-03.png' },
    { id: 'slide-3',       label: 'Punto 3',    file: 'slide-04.png' },
    { id: 'slide-4',       label: 'Punto 4',    file: 'slide-05.png' },
    { id: 'slide-5',       label: 'Punto 5',    file: 'slide-06.png' },
    { id: 'slide-cta',     label: 'CTA',        file: 'slide-07.png' },
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
