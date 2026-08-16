// ── Kinda CM Agent — Generar Long-Lived Token (60 días) ─────────────────
// Intercambia el short-lived token de Graph API Explorer por uno de 60 días.
//
// Requisitos:
//   - APP_ID y APP_SECRET de la app "Kinda CM Publisher"
//     (Meta for Developers → tu app → Configuración → Básica)
//   - metaAccessToken válido en config.js (el token corto de Explorer)
//
// Uso: node get-long-token.js <APP_ID> <APP_SECRET>

'use strict';
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const config = require('./config');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error('Respuesta no es JSON: ' + Buffer.concat(chunks).toString().slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const [,, appId, appSecret] = process.argv;

  if (!appId || !appSecret) {
    console.error('Uso: node get-long-token.js <APP_ID> <APP_SECRET>');
    console.error('');
    console.error('Dónde obtenerlos:');
    console.error('  https://developers.facebook.com/apps/ → Kinda CM Publisher');
    console.error('  → Configuración → Básica → ID de la aplicación / Clave secreta');
    process.exit(1);
  }

  const shortToken = config.metaAccessToken;
  if (!shortToken || shortToken.length < 20) {
    console.error('metaAccessToken no encontrado o inválido en config.js');
    process.exit(1);
  }

  console.log('Intercambiando token corto por token de 60 días...');

  const url = `https://graph.facebook.com/oauth/access_token` +
    `?grant_type=fb_exchange_token` +
    `&client_id=${appId}` +
    `&client_secret=${appSecret}` +
    `&fb_exchange_token=${shortToken}`;

  const res = await get(url);

  if (res.error) {
    console.error('Error de Meta API:', res.error.message);
    console.error('Código:', res.error.code, '| Tipo:', res.error.type);
    process.exit(1);
  }

  const longToken  = res.access_token;
  const expiresIn  = res.expires_in;  // segundos
  const expireDays = Math.round(expiresIn / 86400);
  const expireDate = new Date(Date.now() + expiresIn * 1000).toLocaleDateString('es-CL');

  console.log('');
  console.log('✅ Token de larga duración obtenido:');
  console.log(`   Expira en: ${expireDays} días (aprox. ${expireDate})`);
  console.log('');
  console.log('Token:');
  console.log(longToken);
  console.log('');

  // Actualizar config.js automáticamente
  const configPath = path.join(__dirname, 'config.js');
  let configContent = fs.readFileSync(configPath, 'utf8');

  const oldTokenMatch = configContent.match(/metaAccessToken:\s*'([^']+)'/);
  if (!oldTokenMatch) {
    console.error('No se encontró metaAccessToken en config.js — actualiza manualmente.');
    process.exit(1);
  }

  configContent = configContent.replace(
    /metaAccessToken:\s*'[^']+'/,
    `metaAccessToken: '${longToken}'`
  );
  fs.writeFileSync(configPath, configContent, 'utf8');

  console.log(`✅ config.js actualizado con el token de ${expireDays} días.`);
  console.log(`   Próxima renovación: antes del ${expireDate}`);
  console.log('');
  console.log('Nota: guarda el token en un lugar seguro por si necesitas restaurarlo.');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
