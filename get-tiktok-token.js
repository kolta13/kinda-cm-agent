// ── Kinda CM Agent — Generador de token inicial de TikTok ────────────────
// Guía al usuario por el flujo OAuth 2.0 + PKCE de TikTok para obtener
// el access_token y refresh_token iniciales.
//
// Uso: node get-tiktok-token.js
//
// Pre-requisitos:
//   1. config.js tiene tiktokClientKey y tiktokClientSecret
//   2. La URI de redirección https://kindaclub.com está registrada en la app TikTok
//   3. La app tiene el scope video.publish aprobado

'use strict';
const https    = require('https');
const crypto   = require('crypto');
const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const config   = require('./config');

// ── PKCE helpers ───────────────────────────────────────────────────────────

function generateCodeVerifier() {
  // 43-128 chars URL-safe random string
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

// ── Readline helper ────────────────────────────────────────────────────────

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ── Actualizar config.js ───────────────────────────────────────────────────

function updateConfigJs(refreshToken, accessToken) {
  const configPath = path.join(__dirname, 'config.js');
  if (!fs.existsSync(configPath)) {
    console.log('\nconfig.js no encontrado. Copia estos valores manualmente:');
    console.log(`  tiktokRefreshToken: '${refreshToken}'`);
    return;
  }

  let src = fs.readFileSync(configPath, 'utf8');

  // Reemplazar tiktokRefreshToken existente o agregar si no está
  if (src.includes('tiktokRefreshToken')) {
    src = src.replace(/tiktokRefreshToken:\s*'[^']*'/, `tiktokRefreshToken: '${refreshToken}'`);
    src = src.replace(/tiktokRefreshToken:\s*"[^"]*"/, `tiktokRefreshToken: '${refreshToken}'`);
  } else {
    // Insertar antes del cierre del objeto
    src = src.replace(/(\btiktokAccessToken\s*:\s*'[^']*')/, `$1,\n  tiktokRefreshToken: '${refreshToken}'`);
  }

  fs.writeFileSync(configPath, src, 'utf8');
  console.log('\n✅ config.js actualizado con tiktokRefreshToken');
}

// ── Flujo principal ────────────────────────────────────────────────────────

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Kinda CM Agent — Generador de Token TikTok (OAuth)   ');
  console.log('═══════════════════════════════════════════════════════\n');

  if (!config.tiktokClientKey || !config.tiktokClientSecret) {
    console.error('❌ Faltan tiktokClientKey o tiktokClientSecret en config.js');
    console.error('   Agrégalos con los valores del TikTok Developer Portal.');
    rl.close();
    process.exit(1);
  }

  // Generar PKCE
  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state         = crypto.randomBytes(8).toString('hex');

  // URI de redirección registrada en la app TikTok
  const redirectUri = 'https://kindaclub.com';

  // Construir URL de autorización
  const authParams = new URLSearchParams({
    client_key:             config.tiktokClientKey,
    scope:                  'video.publish',
    response_type:          'code',
    redirect_uri:           redirectUri,
    state,
    code_challenge:         codeChallenge,
    code_challenge_method:  'S256',
  });
  const authUrl = `https://www.tiktok.com/v2/auth/authorize/?${authParams.toString()}`;

  console.log('PASO 1: Abre esta URL en tu navegador y autoriza la app:\n');
  console.log(authUrl);
  console.log('\n────────────────────────────────────────────────────────');
  console.log('PASO 2: Después de autorizar, TikTok redirige a kindaclub.com');
  console.log('        La URL tendrá este formato:');
  console.log('        https://kindaclub.com?code=XXXXX&state=...\n');
  console.log('        Copia el valor del parámetro "code" de la URL.\n');

  const rawCode = await prompt(rl, 'Pega aquí el "code" de la URL: ');
  const code    = rawCode.trim();

  if (!code) {
    console.error('❌ No ingresaste ningún código.');
    rl.close();
    process.exit(1);
  }

  console.log('\nIntercambiando código por tokens...');

  let tokenData;
  try {
    tokenData = await httpsPostForm('open.tiktokapis.com', '/v2/oauth/token/', {
      client_key:    config.tiktokClientKey,
      client_secret: config.tiktokClientSecret,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  redirectUri,
      code_verifier: codeVerifier,
    });
  } catch (e) {
    console.error('❌ Error al obtener tokens:', e.message);
    rl.close();
    process.exit(1);
  }

  if (tokenData.error && tokenData.error.code !== 'ok') {
    console.error('❌ Error de TikTok:', tokenData.error.message, `(${tokenData.error.code})`);
    console.error('   Respuesta completa:', JSON.stringify(tokenData, null, 2));
    rl.close();
    process.exit(1);
  }

  const accessToken  = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;
  const expiresIn    = tokenData.expires_in;
  const refreshExpiry = tokenData.refresh_expires_in;

  console.log('\n✅ Tokens obtenidos:');
  console.log(`   Access token:  ${accessToken?.slice(0, 20)}... (expira en ${expiresIn}s)`);
  console.log(`   Refresh token: ${refreshToken?.slice(0, 20)}... (válido por ${Math.round(refreshExpiry / 86400)} días)`);

  updateConfigJs(refreshToken, accessToken);

  console.log('\n════════════════════════════════════════════════════════');
  console.log('PRÓXIMOS PASOS:');
  console.log('');
  console.log('1. Agrega estas variables a GitHub Secrets:');
  console.log('   TIKTOK_CLIENT_KEY     → desde TikTok Developer Portal');
  console.log('   TIKTOK_CLIENT_SECRET  → desde TikTok Developer Portal');
  console.log(`   TIKTOK_REFRESH_TOKEN  → ${refreshToken?.slice(0, 30)}...`);
  console.log('   KINDA_GITHUB_PAT      → PAT con scope "repo" para rotar el refresh token');
  console.log('');
  console.log('2. El workflow rotará el refresh token automáticamente en cada run.');
  console.log('   Sin rotación automática, el token expira en 365 días.');
  console.log('════════════════════════════════════════════════════════\n');

  rl.close();
}

main().catch(e => {
  console.error('Error fatal:', e.message);
  process.exit(1);
});
