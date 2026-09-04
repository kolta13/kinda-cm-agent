// ── Kinda CM Agent — Generador de token inicial de TikTok ────────────────
// Flujo OAuth 2.0 + PKCE de TikTok, dividido en dos pasos no-interactivos
// (para poder correrlo desde un agente sin terminal interactiva):
//
//   Paso 1: node get-tiktok-token.js
//           → genera la URL de autorización y guarda el code_verifier
//             temporalmente en data/.tiktok_pkce.json
//
//   Paso 2 (después de autorizar en el navegador y copiar el "code" de la URL):
//           node get-tiktok-token.js <code>
//           → intercambia el code por access_token/refresh_token,
//             actualiza config.js, borra el archivo temporal
//
// Pre-requisitos:
//   1. config.js tiene tiktokClientKey y tiktokClientSecret
//   2. La URI de redirección https://kindaclub.com está registrada en la app TikTok
//   3. La app tiene el scope video.publish (via Content Posting API > Direct Post)

'use strict';
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const config = require('./config');

const PKCE_PATH   = path.join(__dirname, 'data', '.tiktok_pkce.json');
const REDIRECT_URI = 'https://kindaclub.com';

// ── PKCE helpers ───────────────────────────────────────────────────────────

function generateCodeVerifier() {
  return crypto.randomBytes(48).toString('base64url').slice(0, 64);
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── HTTP helper ────────────────────────────────────────────────────────────

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
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Actualizar config.js ───────────────────────────────────────────────────

function updateConfigJs(refreshToken) {
  const configPath = path.join(__dirname, 'config.js');
  if (!fs.existsSync(configPath)) {
    console.log('\nconfig.js no encontrado. Copia este valor manualmente:');
    console.log(`  tiktokRefreshToken: '${refreshToken}'`);
    return;
  }

  let src = fs.readFileSync(configPath, 'utf8');

  if (src.includes('tiktokRefreshToken')) {
    src = src.replace(/tiktokRefreshToken:\s*'[^']*'/, `tiktokRefreshToken: '${refreshToken}'`);
    src = src.replace(/tiktokRefreshToken:\s*"[^"]*"/, `tiktokRefreshToken: '${refreshToken}'`);
  } else {
    src = src.replace(/(\btiktokClientSecret\s*:\s*'[^']*')/, `$1,\n  tiktokRefreshToken: '${refreshToken}'`);
  }

  fs.writeFileSync(configPath, src, 'utf8');
  console.log('\n✅ config.js actualizado con tiktokRefreshToken');
}

// ── Paso 1: generar URL de autorización ────────────────────────────────────

function step1_generateAuthUrl() {
  if (!config.tiktokClientKey || !config.tiktokClientSecret) {
    console.error('❌ Faltan tiktokClientKey o tiktokClientSecret en config.js');
    process.exit(1);
  }

  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state         = crypto.randomBytes(8).toString('hex');

  // Guardar el code_verifier para el paso 2 (vence en la práctica en minutos,
  // el archivo es efímero y nunca se commitea)
  fs.mkdirSync(path.dirname(PKCE_PATH), { recursive: true });
  fs.writeFileSync(PKCE_PATH, JSON.stringify({ codeVerifier, state, created_at: new Date().toISOString() }), 'utf8');

  const authParams = new URLSearchParams({
    client_key:            config.tiktokClientKey,
    // video.publish = publicación directa (requiere auditoría de Direct Post).
    // video.upload  = subir como borrador a la bandeja del creador; es el modo
    //                 de respaldo mientras esa auditoría no esté aprobada.
    // Pedir ambos: sin video.upload el fallback a borrador devuelve
    // scope_not_authorized aunque el scope esté habilitado en la app.
    scope:                 'video.publish,video.upload',
    response_type:         'code',
    redirect_uri:          REDIRECT_URI,
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });
  const authUrl = `https://www.tiktok.com/v2/auth/authorize/?${authParams.toString()}`;

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Kinda CM Agent — Autorización TikTok (paso 1/2)      ');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('Abre esta URL, inicia sesión con la cuenta de prueba (@kindaclub)');
  console.log('y autoriza la app:\n');
  console.log(authUrl);
  console.log('\n────────────────────────────────────────────────────────');
  console.log('Después de autorizar, TikTok redirige a algo como:');
  console.log('  https://kindaclub.com/?code=XXXXX&scopes=...&state=...\n');
  console.log('Copia el valor de "code" (hasta el próximo &) y corre:');
  console.log('  node get-tiktok-token.js <code>');
  console.log('════════════════════════════════════════════════════════\n');
}

// ── Paso 2: intercambiar code por tokens ───────────────────────────────────

async function step2_exchangeCode(code) {
  if (!fs.existsSync(PKCE_PATH)) {
    console.error('❌ No hay una autorización en curso (falta data/.tiktok_pkce.json).');
    console.error('   Corre primero: node get-tiktok-token.js  (sin argumentos)');
    process.exit(1);
  }

  const { codeVerifier } = JSON.parse(fs.readFileSync(PKCE_PATH, 'utf8'));

  console.log('Intercambiando código por tokens...');

  let tokenData;
  try {
    tokenData = await httpsPostForm('open.tiktokapis.com', '/v2/oauth/token/', {
      client_key:    config.tiktokClientKey,
      client_secret: config.tiktokClientSecret,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  REDIRECT_URI,
      code_verifier: codeVerifier,
    });
  } catch (e) {
    console.error('❌ Error al obtener tokens:', e.message);
    process.exit(1);
  }

  if (tokenData.error && tokenData.error.code !== 'ok') {
    console.error('❌ Error de TikTok:', tokenData.error.message, `(${tokenData.error.code})`);
    console.error('   Respuesta completa:', JSON.stringify(tokenData, null, 2));
    process.exit(1);
  }

  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, refresh_expires_in: refreshExpiry } = tokenData;

  console.log('\n✅ Tokens obtenidos:');
  console.log(`   Access token:  ${accessToken?.slice(0, 20)}... (expira en ${expiresIn}s)`);
  console.log(`   Refresh token: ${refreshToken?.slice(0, 20)}... (válido por ${Math.round(refreshExpiry / 86400)} días)`);

  updateConfigJs(refreshToken);
  fs.unlinkSync(PKCE_PATH); // limpiar — ya no se necesita

  console.log('\n════════════════════════════════════════════════════════');
  console.log('PRÓXIMOS PASOS:');
  console.log('');
  console.log('1. Agrega estas variables a GitHub Secrets (solo para producción real):');
  console.log('   TIKTOK_CLIENT_KEY     → desde TikTok Developer Portal');
  console.log('   TIKTOK_CLIENT_SECRET  → desde TikTok Developer Portal');
  console.log(`   TIKTOK_REFRESH_TOKEN  → ${refreshToken?.slice(0, 30)}...`);
  console.log('   KINDA_GITHUB_PAT      → PAT con scope "repo" para rotar el refresh token');
  console.log('');
  console.log('2. Para probar ahora en Sandbox: node demo-tiktok-sandbox.js');
  console.log('════════════════════════════════════════════════════════\n');
}

// ── Main ────────────────────────────────────────────────────────────────

const rawCode = process.argv[2];
if (rawCode) {
  // El "code" viene URL-encoded en el redirect (ej. %2A, %21) — decodificar
  // antes de usarlo, tal como llega copiado directo de la barra de direcciones.
  const code = decodeURIComponent(rawCode);
  step2_exchangeCode(code).catch(e => { console.error('Error fatal:', e.message); process.exit(1); });
} else {
  step1_generateAuthUrl();
}
