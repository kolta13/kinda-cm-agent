// ── Kinda CM Agent — Demo Sandbox para TikTok Developer Portal ──────────
// Corre el flujo COMPLETO de punta a punta contra el Sandbox de TikTok
// (mientras la app no esté aprobada): renderiza slides frescos, los sube
// por FTP, y los publica. Pensado para GRABAR EL VIDEO DEMO que pide
// TikTok al submitear la app a revisión — muestra render → upload →
// publish, no solo el último paso.
//
// Pre-requisitos:
//   1. En TikTok Developer Portal, activar el toggle "Sandbox" (junto a Production)
//   2. Agregar tu cuenta de TikTok de prueba (PERSONAL, no de negocio) como
//      "Target User" del Sandbox, y ponerla en privado (Settings > Privacy)
//   3. Correr: node get-tiktok-token.js  (autorizar CON esa cuenta de prueba)
//   4. tiktokClientKey/tiktokClientSecret/tiktokRefreshToken ya en config.js
//   5. data/carousel_latest.json debe existir (corre generate.js si no)
//
// Uso: node demo-tiktok-sandbox.js
//
// Qué hace, paso a paso (útil para narrar mientras grabas):
//   1. Renderiza slides frescos (JPG, 1080x1350) desde carousel_latest.json
//   2. Sube los slides por FTP y obtiene URLs públicas
//   3. Refresca el access token de TikTok
//   4. Consulta creator_info (qué cuenta está conectada, qué niveles de
//      privacidad tiene permitidos — esto es lo que TikTok revisa: que la
//      app respete las restricciones del Sandbox)
//   5. Publica el carrusel de fotos (privacy_level se resuelve automático:
//      SELF_ONLY mientras la app no esté aprobada)
//   6. Espera confirmación y muestra el resultado

'use strict';
const fs      = require('fs');
const path    = require('path');
const config  = require('./config');
const { render }       = require('./render');
const { uploadSlides } = require('./publish');
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
  console.log('  (render → upload → publish, de punta a punta)         ');
  console.log('═══════════════════════════════════════════════════════');

  if (!config.tiktokClientKey || !config.tiktokClientSecret || !config.tiktokRefreshToken) {
    console.error('\n❌ Faltan tiktokClientKey / tiktokClientSecret / tiktokRefreshToken en config.js');
    console.error('   1. Completa tiktokClientKey y tiktokClientSecret (TikTok Developer Portal)');
    console.error('   2. Corre: node get-tiktok-token.js  (autoriza con tu cuenta de prueba del Sandbox)');
    process.exit(1);
  }

  const carouselPath = path.join(__dirname, 'data', 'carousel_latest.json');
  if (!fs.existsSync(carouselPath)) {
    console.error('\n❌ No existe data/carousel_latest.json — corre generate.js primero.');
    process.exit(1);
  }

  // ── Paso 1: renderizar slides frescos ───────────────────────────────────
  step(1, 'Renderizando slides (JPG, 1080x1350)...');
  const manifest = await render();
  console.log(`  ✓ ${manifest.slides.length} slides renderizados: "${manifest.tema}"`);

  // ── Paso 2: subir por FTP ────────────────────────────────────────────────
  step(2, 'Subiendo slides por FTP...');
  const imageUrls = await uploadSlides(manifest);
  imageUrls.forEach((url, i) => console.log(`    slide ${i + 1}: ${url}`));

  // ── Paso 3: refrescar token ──────────────────────────────────────────────
  step(3, 'Refrescando access token de TikTok...');
  const { access_token } = await refreshAccessToken();

  // ── Paso 4: consultar creator_info ───────────────────────────────────────
  step(4, 'Consultando información del creador y niveles de privacidad permitidos...');
  const creatorInfo  = await queryCreatorInfo(access_token);
  const privacyLevel = resolvePrivacyLevel(creatorInfo);
  console.log(`\n  → Publicando como: ${privacyLevel}`);
  if (privacyLevel === 'SELF_ONLY') {
    console.log('  → Esto es esperado: la app aún no está aprobada, así que TikTok');
    console.log('    solo permite posts privados (visibles solo para esta cuenta de prueba).');
  }

  // ── Paso 5: publicar ─────────────────────────────────────────────────────
  step(5, `Publicando carrusel de ${imageUrls.length} fotos en TikTok Sandbox...`);
  const publishId = await initPhotoPost(access_token, imageUrls, manifest.caption, privacyLevel);

  // ── Paso 6: esperar confirmación ─────────────────────────────────────────
  step(6, 'Esperando confirmación de TikTok...');
  const postId = await waitForPublish(access_token, publishId);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ✅ DEMO COMPLETADO');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Tema:          ${manifest.tema}`);
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
