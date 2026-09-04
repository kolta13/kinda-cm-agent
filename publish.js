// ── Kinda CM Agent — Fase 4: Publicación en Instagram ───────────────────
// Lee render_latest.json, sube los slides por FTP y los publica como
// carrusel en Instagram via Meta Graph API.
//
// Uso: node publish.js

'use strict';
const fs      = require('fs');
const path    = require('path');
const ftp     = require('basic-ftp');
const https   = require('https');
const config  = require('./config');
const backlog = require('./backlog');
const history = require('./history');
const { withRetry } = require('./retry');

const DATA_DIR = path.join(__dirname, 'data');
const META_API = 'graph.facebook.com';
const META_VER = 'v22.0'; // Instagram Business API (instagram_business_content_publish)

// ── FTP: subir slides al servidor ─────────────────────────────────────

async function uploadSlides(manifest) {
  // Una sola conexión FTP, uploads secuenciales con pausa entre archivos.
  // NO usar Promise.all aquí — múltiples conexiones simultáneas pueden
  // saturar el hosting compartido y tumbar todos los dominios.
  const client = new ftp.Client(30000); // timeout 30s
  client.ftp.verbose = false;

  try {
    await client.access({
      host:     config.ftpHost,
      user:     config.ftpUser,
      password: config.ftpPass,
      secure:   false,
    });

    // dirName viene del render y puede llevar sufijo (-2, -3) si hubo más de un
    // post el mismo día. Sin él, dos corridas del mismo día suben a la misma
    // carpeta remota y la segunda pisa las imágenes de la primera — le pasó al
    // post del 29-08-2026. Fallback a `week` para manifiestos viejos.
    const remoteDirName = manifest.dirName || `semana-${manifest.week}`;
    const remoteWeekDir = `${config.ftpOutputPath}/${remoteDirName}`;
    await client.ensureDir(remoteWeekDir);
    console.log(`[publish] Directorio remoto: ${remoteWeekDir}`);

    const urls = [];
    for (const slide of manifest.slides) {
      const remotePath = `${remoteWeekDir}/${slide.file}`;
      await client.uploadFrom(slide.path, remotePath);
      const url = `${config.agentBaseUrl}/output/${remoteDirName}/${slide.file}`;
      urls.push(url);
      console.log(`  ✓ ${slide.file}`);
      // Pausa entre uploads para no saturar el servidor
      await new Promise(r => setTimeout(r, 800));
    }

    return urls;
  } finally {
    client.close();
  }
}

// ── Meta Graph API helper ─────────────────────────────────────────────

function metaPostOnce(endpoint, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const opts = {
      hostname: META_API,
      path:     `/${META_VER}/${endpoint}`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (data.error) return reject(new Error(`Meta API: ${data.error.message}`));
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Meta API timeout')); });
    req.write(body);
    req.end();
  });
}

// Con retry — seguro para creación de containers (idempotente: crear de más no publica nada)
function metaPost(endpoint, params) {
  return withRetry(() => metaPostOnce(endpoint, params), { label: `Meta API (${endpoint})` });
}

// ── Meta: crear containers individuales (uno por slide) ──────────────

async function createImageContainers(imageUrls) {
  console.log('[publish] Creando containers de imagen en Meta...');
  const ids = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const res = await metaPost(`${config.metaIgUserId}/media`, {
      image_url:        imageUrls[i],
      is_carousel_item: true,
      access_token:     config.metaAccessToken,
    });
    ids.push(res.id);
    console.log(`  ✓ Container ${i + 1}/${imageUrls.length}: ${res.id}`);
  }

  return ids;
}

// ── Meta: crear container del carrusel ───────────────────────────────

async function createCarouselContainer(containerIds, caption) {
  console.log('[publish] Creando container de carrusel...');
  const res = await metaPost(`${config.metaIgUserId}/media`, {
    media_type:   'CAROUSEL',
    children:     containerIds.join(','),
    caption,
    access_token: config.metaAccessToken,
  });
  console.log(`  ✓ Carousel container: ${res.id}`);
  return res.id;
}

// ── Meta: esperar a que el container esté listo ───────────────────────

function metaGet(path) {
  return new Promise((resolve, reject) => {
    const url = `https://${META_API}/${META_VER}/${path}&access_token=${config.metaAccessToken}`;
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (data.error) return reject(new Error(`Meta API: ${data.error.message}`));
        resolve(data);
      });
    }).on('error', reject);
  });
}

async function waitUntilReady(containerId, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await metaGet(`${containerId}?fields=status_code`);
    console.log(`  ⏳ Status: ${status.status_code}`);
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR')    throw new Error('Container falló el procesamiento');
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error('Timeout esperando que el container esté listo');
}

// ── Meta: publicar ────────────────────────────────────────────────────

async function publishCarousel(carouselContainerId) {
  console.log('[publish] Esperando que Meta procese el carrusel...');
  await waitUntilReady(carouselContainerId);

  console.log('[publish] Publicando carrusel...');
  // Sin retry: un timeout acá es ambiguo (pudo haber publicado igual).
  // Reintentar arriesgaría duplicar el post en el feed.
  const res = await metaPostOnce(`${config.metaIgUserId}/media_publish`, {
    creation_id:  carouselContainerId,
    access_token: config.metaAccessToken,
  });
  console.log(`  ✓ Publicado. Post ID: ${res.id}`);
  return res.id;
}

// ── Función principal ─────────────────────────────────────────────────

async function publish() {
  // Validar credenciales
  if (!config.metaAccessToken || !config.metaIgUserId) {
    console.error('[publish] Faltan metaAccessToken o metaIgUserId en config.js');
    console.error('  → Obtén el token en: https://developers.facebook.com/tools/explorer/');
    console.error('  → Permisos necesarios: instagram_business_basic + instagram_content_publish');
    process.exit(1);
  }

  // Leer manifiesto del render
  const manifestPath = path.join(DATA_DIR, 'render_latest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('[publish] No existe render_latest.json — corre render.js primero');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`[publish] Semana ${manifest.week}: "${manifest.tema}"`);
  console.log(`[publish] ${manifest.slides.length} slides a publicar`);

  // Leer caption y metadata completa desde carousel_latest.json (regen-caption.js
  // actualiza el caption ahí, no en render_latest.json). Fallback al manifiesto si no existe.
  const carouselPath = path.join(DATA_DIR, 'carousel_latest.json');
  let caption = manifest.caption || '';
  let carouselData = null;
  if (fs.existsSync(carouselPath)) {
    carouselData = JSON.parse(fs.readFileSync(carouselPath, 'utf8'));
    const freshCaption = carouselData.carousel?.caption_instagram;
    if (freshCaption) caption = freshCaption;
  }
  console.log('[publish] Caption preview:', caption.slice(0, 80) + '...');

  // Paso 1: subir slides por FTP
  console.log('\n[publish] Subiendo slides por FTP...');
  const imageUrls = await uploadSlides(manifest);

  // Paso 2: crear containers individuales
  console.log('');
  const containerIds = await createImageContainers(imageUrls);

  // Paso 3: crear container del carrusel con caption
  console.log('');
  const carouselId = await createCarouselContainer(containerIds, caption);

  // Paso 4: publicar
  console.log('');
  const postId = await publishCarousel(carouselId);

  // Marcar idea como publicada en el backlog
  if (manifest.backlog_id) {
    const marked = backlog.markPublished(manifest.backlog_id, postId);
    if (marked) console.log(`[publish] Backlog actualizado → idea "${manifest.tema}" marcada como publicada`);
  }

  // Archivar el post en el histórico permanente (para retro y mejora continua)
  history.appendPost({
    platform:      'instagram',
    week:          manifest.week,
    tema:          manifest.tema,
    topic_tag:     carouselData?.topic_tag,
    audience_type: carouselData?.carousel?.audience_type,
    formato:       carouselData?.formato,
    cta_mode:      carouselData?.cta_mode,
    backlog_id:    manifest.backlog_id,
    winner_score:  carouselData?.winner_score,
    post_id:       postId,
    caption,
    hashtags:      carouselData?.carousel?.hashtags,
    slides:        carouselData?.carousel?.slides,
    image_urls:    imageUrls,
  });
  console.log('[publish] Post archivado en data/post_history.json');

  // Guardar resultado
  const result = {
    published_at: new Date().toISOString(),
    week:         manifest.week,
    tema:         manifest.tema,
    post_id:      postId,
    image_urls:   imageUrls,
  };
  fs.writeFileSync(
    path.join(DATA_DIR, 'publish_latest.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );

  const st = backlog.stats();
  console.log(`\n[publish] ✅ Carrusel publicado en Instagram`);
  console.log(`  Post ID: ${postId}`);
  console.log(`  Backlog: ${st.pending} ideas pendientes / ${st.published} publicadas`);
  return result;
}

if (require.main === module) {
  publish().catch(e => { console.error('[publish] Error fatal:', e.message); process.exit(1); });
}

module.exports = { publish, uploadSlides };
