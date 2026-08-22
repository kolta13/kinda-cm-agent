// ── Kinda CM Agent — Demo Sandbox para TikTok Developer Portal ──────────
// Corre el flujo de publicación en TikTok de punta a punta contra el
// Sandbox (mientras la app no esté aprobada), usando las imágenes del
// último post publicado en Instagram. Pensado para GRABAR EL VIDEO DEMO
// que pide TikTok al submitear la app a revisión.
//
// Pre-requisitos:
//   1. En TikTok Developer Portal, activar el toggle "Sandbox" (junto a Production)
//   2. Agregar tu cuenta de TikTok de prueba como "Target User" del Sandbox
//   3. Correr: node get-tiktok-token.js  (autorizar CON esa cuenta de prueba)
//   4. tiktokClientKey/tiktokClientSecret/tiktokRefreshToken ya en config.js
//
// Uso: node demo-tiktok-sandbox.js
//
// Qué hace, paso a paso (útil para narrar mientras grabas):
//   1. Refresca el access token
//   2. Consulta creator_info (muestra qué cuenta está conectada y qué
//      niveles de privacidad tiene permitidos — esto es lo que TikTok
//      quiere ver: la app respeta las restricciones del Sandbox)
//   3. Toma las imágenes del último post publicado (data/post_history.json)
//   4. Publica el carrusel de fotos como SELF_ONLY (privado — visible solo
//      para la cuenta de prueba, como exige el Sandbox)
//   5. Espera confirmación y muestra el resultado

'use strict';
const fs      = require('fs');
const path    = require('path');
const config  = require('./config');
const history = require('./history');
const {
  refreshAccessToken,
  queryCreatorInfo,
  resolvePrivacyLevel,
  initPhotoPost,
  waitForPublish,
} = require('./publish-tiktok');

function step(n, msg) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`PASO ${n}: ${msg}`);
  console.log('─'.repeat(60));
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Kinda CM Agent — Demo Sandbox de TikTok               ');
  console.log('═══════════════════════════════════════════════════════');

  if (!config.tiktokClientKey || !config.tiktokClientSecret || !config.tiktokRefreshToken) {
    console.error('\n❌ Faltan tiktokClientKey / tiktokClientSecret / tiktokRefreshToken en config.js');
    console.error('   1. Completa tiktokClientKey y tiktokClientSecret (TikTok Developer Portal)');
    console.error('   2. Corre: node get-tiktok-token.js  (autoriza con tu cuenta de prueba del Sandbox)');
    process.exit(1);
  }

  // ── Paso 1: refrescar token ────────────────────────────────────────────
  step(1, 'Refrescando access token...');
  const { access_token } = await refreshAccessToken();

  // ── Paso 2: consultar creator_info ─────────────────────────────────────
  step(2, 'Consultando información del creador y niveles de privacidad permitidos...');
  const creatorInfo  = await queryCreatorInfo(access_token);
  const privacyLevel = resolvePrivacyLevel(creatorInfo);
  console.log(`\n  → Publicando como: ${privacyLevel}`);
  if (privacyLevel === 'SELF_ONLY') {
    console.log('  → Esto es esperado: la app aún no está aprobada, así que TikTok');
    console.log('    solo permite posts privados (visibles solo para esta cuenta de prueba).');
  }

  // ── Paso 3: tomar imágenes del último post publicado ───────────────────
  step(3, 'Buscando imágenes del último post publicado...');
  const recent = history.getRecent(1)[0];
  let imageUrls, caption, tema;

  if (recent && recent.image_urls && recent.image_urls.length > 0) {
    imageUrls = recent.image_urls;
    caption   = recent.caption || recent.tema;
    tema      = recent.tema;
    console.log(`  ✓ Usando imágenes de: "${tema}" (${imageUrls.length} slides)`);
  } else {
    // Fallback: leer publish_latest.json si existe localmente
    const publishPath = path.join(__dirname, 'data', 'publish_latest.json');
    if (!fs.existsSync(publishPath)) {
      console.error('\n❌ No hay posts en el histórico ni publish_latest.json local.');
      console.error('   Corre el pipeline completo al menos una vez (node agent.js) antes del demo.');
      process.exit(1);
    }
    const publishData = JSON.parse(fs.readFileSync(publishPath, 'utf8'));
    imageUrls = publishData.image_urls;
    caption   = publishData.tema;
    tema      = publishData.tema;
    console.log(`  ✓ Usando imágenes de publish_latest.json: "${tema}" (${imageUrls.length} slides)`);
  }

  imageUrls.forEach((url, i) => console.log(`    slide ${i + 1}: ${url}`));

  // ── Paso 4: publicar ────────────────────────────────────────────────────
  step(4, `Publicando carrusel de ${imageUrls.length} fotos en TikTok Sandbox...`);
  const publishId = await initPhotoPost(access_token, imageUrls, caption, privacyLevel);

  // ── Paso 5: esperar confirmación ────────────────────────────────────────
  step(5, 'Esperando confirmación de TikTok...');
  const postId = await waitForPublish(access_token, publishId);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ✅ DEMO COMPLETADO');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Tema:          ${tema}`);
  console.log(`  Privacy level: ${privacyLevel}`);
  console.log(`  Post ID:       ${postId}`);
  console.log(`  Cuenta:        @${creatorInfo.creator_username || '?'}`);
  console.log('\n  Revisa el post en la app de TikTok (cuenta de prueba del Sandbox)');
  console.log('  para confirmar visualmente que se publicó correctamente.');
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(e => {
  console.error('\n❌ Error en el demo:', e.message);
  process.exit(1);
});
