// ── Kinda CM Agent — Fase 4b: Publicación en TikTok ─────────────────────
// Lee publish_latest.json (URLs de slides ya subidos por FTP) y los publica
// como carrusel de fotos en TikTok via Content Posting API v2.
//
// Requiere en config.js:
//   tiktokClientKey, tiktokClientSecret, tiktokRefreshToken
//
// Uso: node publish-tiktok.js

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const config = require('./config');

const DATA_DIR  = path.join(__dirname, 'data');
const TIKTOK_HOST = 'open.tiktokapis.com';

// ── HTTP helpers ───────────────────────────────────────────────────────────

function httpsPost(hostname, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      hostname,
      path: reqPath,
      method: 'POST',
      timeout: 30000,
      headers: {
        'Content-Type':   'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error(`JSON parse error: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TikTok API timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

function httpsPostForm(hostname, reqPath, formData) {
  const body = new URLSearchParams(formData).toString();
  return new Promise((resolve, reject) => {
    const opts = {
      hostname,
      path: reqPath,
      method: 'POST',
      timeout: 30000,
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error(`JSON parse error: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TikTok token timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Token: refrescar access token ─────────────────────────────────────────

async function refreshAccessToken() {
  console.log('[tiktok] Refrescando access token...');
  const res = await httpsPostForm(TIKTOK_HOST, '/v2/oauth/token/', {
    client_key:    config.tiktokClientKey,
    client_secret: config.tiktokClientSecret,
    grant_type:    'refresh_token',
    refresh_token: config.tiktokRefreshToken,
  });

  if (res.error && res.error.code !== 'ok') {
    throw new Error(`TikTok token refresh: ${res.error.message} (${res.error.code})`);
  }
  if (!res.access_token) {
    throw new Error(`TikTok token refresh fallido: ${JSON.stringify(res)}`);
  }

  console.log(`  ✓ Access token renovado (expira en ${res.expires_in}s)`);
  return {
    access_token:  res.access_token,
    refresh_token: res.refresh_token,
    expires_in:    res.expires_in,
  };
}

// Guardar nuevo refresh token para que el paso del workflow lo rote en Secrets
function saveNewRefreshToken(refreshToken) {
  const tokenPath = path.join(DATA_DIR, 'tiktok_token.json');
  fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: refreshToken }, null, 2), 'utf8');
  console.log('  ✓ Nuevo refresh token guardado en data/tiktok_token.json');
}

// ── TikTok: consultar info del creador + niveles de privacidad permitidos ──
// Paso obligatorio según la doc de TikTok antes de publicar (Content Posting API
// Sandbox Requirements): mientras la app no esté auditada/aprobada, TikTok solo
// permite privacy_level: 'SELF_ONLY' (post privado, visible solo para el creador
// de prueba agregado al Sandbox). Una vez aprobada la app, PUBLIC_TO_EVERYONE
// aparece disponible automáticamente en creator_info_options — por eso este
// código NO hardcodea el nivel, lo resuelve en cada corrida.

async function queryCreatorInfo(accessToken) {
  console.log('[tiktok] Consultando creator_info (requerido antes de publicar)...');
  const res = await httpsPost(
    TIKTOK_HOST,
    '/v2/post/publish/creator_info/query/',
    {},
    { Authorization: `Bearer ${accessToken}` }
  );

  if (res.error && res.error.code !== 'ok') {
    throw new Error(`TikTok creator_info: ${res.error.message} (${res.error.code})`);
  }

  const info = res.data || {};
  console.log(`  ✓ Creador: @${info.creator_username || '?'} (${info.creator_nickname || '?'})`);
  console.log(`  ✓ Niveles de privacidad permitidos: ${(info.privacy_level_options || []).join(', ') || '(ninguno devuelto)'}`);
  return info;
}

// Elige el nivel de privacidad más abierto que la app tenga permitido en este momento.
// PUBLIC_TO_EVERYONE si ya está aprobada; si no, cae a SELF_ONLY (obligatorio en Sandbox).
function resolvePrivacyLevel(creatorInfo) {
  const options = creatorInfo.privacy_level_options || [];
  if (options.includes('PUBLIC_TO_EVERYONE')) return 'PUBLIC_TO_EVERYONE';
  if (options.includes('SELF_ONLY'))          return 'SELF_ONLY';
  return options[0] || 'SELF_ONLY';
}

// ── TikTok: iniciar publicación de fotos ──────────────────────────────────

// Siempre como BORRADOR (post_mode MEDIA_UPLOAD). No se intenta DIRECT_POST:
// la auditoría se rechazó el 04-09-2026 y las Content Sharing Guidelines lo
// prohíben para un flujo automático — el punto 5 exige que el usuario "expressly
// consent" antes de cada subida, además de elegir privacidad sin valor por defecto,
// marcar interacciones y aceptar la declaración de música. Un proceso sin pantalla
// nunca va a cumplir eso.
//
// El borrador llega como notificación a la bandeja de la app de TikTok de la
// cuenta que autorizó (@kindaclub). Ahí TikTok muestra su propio flujo de
// publicación con el consentimiento incluido. Solo requiere el scope video.upload.
async function initPhotoPost(accessToken, imageUrls, caption) {
  console.log(`[tiktok] Subiendo ${imageUrls.length} fotos como borrador...`);

  // En posts de FOTO, TikTok separa "title" (corto, ~90 chars) de "description"
  // (el caption largo) — a diferencia de video, donde solo existe "title".
  const title       = caption.split('\n')[0].slice(0, 90);
  const description = caption.slice(0, 2200);

  const res = await httpsPost(
    TIKTOK_HOST,
    '/v2/post/publish/content/init/',
    {
      post_info:   { title, description },
      source_info: {
        source:            'PULL_FROM_URL',
        photo_images:      imageUrls,
        photo_cover_index: 0,
      },
      post_mode:  'MEDIA_UPLOAD', // requerido junto con media_type
      media_type: 'PHOTO',
    },
    { Authorization: `Bearer ${accessToken}` }
  );

  if (res.error && res.error.code !== 'ok') {
    throw new Error(`TikTok upload: ${res.error.message} (${res.error.code})`);
  }

  const publishId = res.data?.publish_id;
  if (!publishId) throw new Error(`TikTok: no publish_id en respuesta: ${JSON.stringify(res)}`);

  console.log(`  ✓ Subida iniciada. ID: ${publishId}`);
  return { publishId, modo: 'MEDIA_UPLOAD' };
}

// ── TikTok: esperar hasta que se publique ─────────────────────────────────

async function waitForPublish(accessToken, publishId, maxWaitMs = 90000) {
  console.log('[tiktok] Esperando confirmación de publicación...');
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));

    const res = await httpsPost(
      TIKTOK_HOST,
      '/v2/post/publish/status/fetch/',
      { publish_id: publishId },
      { Authorization: `Bearer ${accessToken}` }
    );

    const status = res.data?.status;
    console.log(`  ⏳ Status: ${status}`);

    if (status === 'PUBLISH_COMPLETE') {
      const postIds = res.data?.publicaly_available_post_id || [];
      return postIds[0] || publishId;
    }
    // Estado terminal del modo borrador: el carrusel ya está en la bandeja de la
    // cuenta y llegó la notificación a TikTok. No hay post público todavía —
    // el creador lo termina desde la app.
    if (status === 'SEND_TO_USER_INBOX') {
      console.log('  ✓ Borrador enviado a la bandeja de TikTok — termínalo desde la app');
      return publishId;
    }
    if (status === 'FAILED') {
      const reason = res.data?.fail_reason || 'unknown';
      throw new Error(`TikTok publicación falló: ${reason}`);
    }
  }

  throw new Error('Timeout esperando publicación en TikTok');
}

// ── Función principal ─────────────────────────────────────────────────────

async function publishTikTok() {
  // Verificar credenciales
  if (!config.tiktokClientKey || !config.tiktokClientSecret || !config.tiktokRefreshToken) {
    console.log('[tiktok] Credenciales no configuradas — saltando publicación TikTok');
    return null;
  }

  // Leer URLs de slides (ya subidas a FTP por publish.js)
  const publishPath = path.join(DATA_DIR, 'publish_latest.json');
  if (!fs.existsSync(publishPath)) {
    throw new Error('[tiktok] No existe publish_latest.json — corre publish.js primero');
  }
  const publishData = JSON.parse(fs.readFileSync(publishPath, 'utf8'));
  const imageUrls   = publishData.image_urls;
  if (!imageUrls || imageUrls.length === 0) {
    throw new Error('[tiktok] No hay image_urls en publish_latest.json');
  }

  // Leer caption
  const carouselPath = path.join(DATA_DIR, 'carousel_latest.json');
  const carouselData = JSON.parse(fs.readFileSync(carouselPath, 'utf8'));
  const caption = carouselData.carousel?.caption_instagram || publishData.tema || '';

  console.log(`[tiktok] Semana ${publishData.week}: "${publishData.tema}"`);
  console.log(`[tiktok] ${imageUrls.length} imágenes a publicar`);

  // 1. Refrescar token (el refresh token rota con cada uso)
  const { access_token, refresh_token } = await refreshAccessToken();
  saveNewRefreshToken(refresh_token);

  // 2. Subir como borrador (ver initPhotoPost: Direct Post no aplica a este flujo)
  const { publishId, modo } = await initPhotoPost(access_token, imageUrls, caption);

  // 3. Esperar confirmación (estado terminal esperado: SEND_TO_USER_INBOX)
  const postId = await waitForPublish(access_token, publishId);

  const result = {
    enviado_at:  new Date().toISOString(),
    week:        publishData.week,
    tema:        publishData.tema,
    publish_id:  publishId,
    post_mode:   modo,
    image_count: imageUrls.length,
  };

  fs.writeFileSync(
    path.join(DATA_DIR, 'publish_tiktok_latest.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );

  console.log(`\n[tiktok] 📥 Carrusel enviado como BORRADOR a la bandeja de TikTok`);
  console.log(`  Aparece como notificación en la app móvil de @kindaclub → Bandeja de entrada.`);
  console.log(`  publish_id: ${postId}`);
  return result;
}

if (require.main === module) {
  publishTikTok().catch(e => {
    console.error('[tiktok] Error:', e.message);
    process.exit(1);
  });
}

module.exports = {
  publishTikTok,
  refreshAccessToken,
  queryCreatorInfo,
  resolvePrivacyLevel,
  initPhotoPost,
  waitForPublish,
};
