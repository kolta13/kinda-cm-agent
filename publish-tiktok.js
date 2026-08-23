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

async function initPhotoPost(accessToken, imageUrls, caption, privacyLevel) {
  console.log(`[tiktok] Iniciando publicación de ${imageUrls.length} fotos (privacy_level: ${privacyLevel})...`);

  // En posts de FOTO, TikTok separa "title" (corto, ~90 chars) de "description"
  // (el caption largo) — a diferencia de video, donde solo existe "title".
  const title       = caption.split('\n')[0].slice(0, 90);
  const description = caption.slice(0, 2200);

  const buildBody = (level) => ({
    post_info: {
      title,
      description,
      privacy_level:   level,
      disable_comment: false,
      auto_add_music:  false, // no agregar música de fondo automática
    },
    source_info: {
      source:            'PULL_FROM_URL',
      photo_images:      imageUrls,
      photo_cover_index: 0,
    },
    post_mode:  'DIRECT_POST', // requerido junto con media_type — su ausencia
                                // causaba "Invalid media_type or post_mode"
    media_type: 'PHOTO',
  });

  let res = await httpsPost(
    TIKTOK_HOST,
    '/v2/post/publish/content/init/',
    buildBody(privacyLevel),
    { Authorization: `Bearer ${accessToken}` }
  );

  // creator_info puede listar PUBLIC_TO_EVERYONE como "permitido" aunque la app
  // no esté auditada todavía — la restricción real solo se aplica acá, al publicar.
  // Reintentar automáticamente como privado en vez de fallar el ciclo completo.
  if (res.error?.code === 'unaudited_client_can_only_post_to_private_accounts' && privacyLevel !== 'SELF_ONLY') {
    console.log('  ⚠ App sin auditar — reintentando como SELF_ONLY (privado)...');
    res = await httpsPost(
      TIKTOK_HOST,
      '/v2/post/publish/content/init/',
      buildBody('SELF_ONLY'),
      { Authorization: `Bearer ${accessToken}` }
    );
  }

  if (res.error && res.error.code !== 'ok') {
    throw new Error(`TikTok post init: ${res.error.message} (${res.error.code})`);
  }

  const publishId = res.data?.publish_id;
  if (!publishId) throw new Error(`TikTok: no publish_id en respuesta: ${JSON.stringify(res)}`);

  console.log(`  ✓ Publish iniciado. ID: ${publishId}`);
  return publishId;
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

  // 2. Consultar qué privacy_level tenemos permitido (SELF_ONLY mientras la app
  //    no esté aprobada; PUBLIC_TO_EVERYONE en cuanto TikTok la audite)
  const creatorInfo  = await queryCreatorInfo(access_token);
  const privacyLevel = resolvePrivacyLevel(creatorInfo);
  if (privacyLevel !== 'PUBLIC_TO_EVERYONE') {
    console.log(`[tiktok] ⚠ App aún no aprobada — publicando como ${privacyLevel} (solo visible para la cuenta de prueba del Sandbox)`);
  }

  // 3. Iniciar publicación
  const publishId = await initPhotoPost(access_token, imageUrls, caption, privacyLevel);

  // 4. Esperar confirmación
  const postId = await waitForPublish(access_token, publishId);

  const result = {
    published_at:  new Date().toISOString(),
    week:          publishData.week,
    tema:          publishData.tema,
    post_id:       postId,
    publish_id:    publishId,
    privacy_level: privacyLevel,
    image_count:   imageUrls.length,
  };

  fs.writeFileSync(
    path.join(DATA_DIR, 'publish_tiktok_latest.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );

  console.log(`\n[tiktok] ✅ Carrusel publicado en TikTok`);
  console.log(`  Post ID: ${postId}`);
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
