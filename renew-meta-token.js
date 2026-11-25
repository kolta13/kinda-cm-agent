// ── Kinda CM Agent — Renovar el token de Meta (sin vencimiento) ─────────────
//
// El token de 60 días venció el 14-10-2026 y el agente estuvo 6 semanas sin publicar.
// Este script lo reemplaza por un TOKEN DE PÁGINA, que no vence mientras no cambies la
// contraseña de Facebook, no quites la app ni pierdas el rol de admin en la página.
//
// Pasos que hace:
//   1. Pide APP_ID, APP_SECRET y un token corto de Graph API Explorer.
//   2. Lo cambia por un token de usuario de 60 días.
//   3. Con ese, obtiene el token de la página de Facebook vinculada a la cuenta de Instagram.
//   4. Revisa con debug_token que no venza y que tenga los permisos necesarios.
//   5. Prueba leer la cuenta de Instagram con él.
//   6. Lo guarda en GitHub Secrets (META_ACCESS_TOKEN) y en config.js.
// El token nunca se imprime en pantalla.
//
// Uso: node renew-meta-token.js

'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const GRAPH = 'https://graph.facebook.com/v21.0';
const REPO = 'kolta13/kinda-cm-agent';
const NEEDED = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'];
const OPTIONAL = ['instagram_manage_insights']; // para la Fase 0 (métricas)

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(text)); } catch { reject(new Error('Respuesta no JSON: ' + text.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function graph(pathAndQuery) {
  const res = await get(`${GRAPH}/${pathAndQuery}`);
  if (res.error) throw new Error(`Meta: ${res.error.message} (código ${res.error.code})`);
  return res;
}

function ask(rl, q) { return new Promise(r => rl.question(q, a => r(a.trim()))); }

function fail(msg) { console.error('\n❌ ' + msg); process.exit(1); }

async function main() {
  const configPath = path.join(__dirname, 'config.js');
  let igUserId = '';
  try { igUserId = require(configPath).metaIgUserId || ''; } catch { /* sin config local */ }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Renovar token de Meta para el CM Agent\n');
  console.log('Datos en https://developers.facebook.com/apps/ → Kinda CM Publisher → Configuración → Básica');
  const appId = await ask(rl, 'APP_ID: ');
  const appSecret = await ask(rl, 'APP_SECRET: ');
  const shortToken = await ask(rl, 'Token corto de Graph API Explorer: ');
  if (!igUserId) igUserId = await ask(rl, 'ID de la cuenta de Instagram (META_IG_USER_ID): ');
  rl.close();
  if (!appId || !appSecret || shortToken.length < 20) fail('Faltan datos.');

  console.log('\n1/5 Cambiando el token corto por uno de 60 días...');
  const long = await graph(`oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(shortToken)}`);

  console.log('2/5 Buscando la página vinculada a la cuenta de Instagram...');
  const pages = await graph(`me/accounts?fields=id,name,access_token,instagram_business_account&limit=100&access_token=${encodeURIComponent(long.access_token)}`);
  const list = pages.data || [];
  let page = list.find(p => p.instagram_business_account && p.instagram_business_account.id === igUserId);
  if (!page && !igUserId) page = list.find(p => p.instagram_business_account);
  if (!page) {
    console.error('Páginas visibles con este token:');
    list.forEach(p => console.error(`  - ${p.name} (Instagram: ${p.instagram_business_account ? p.instagram_business_account.id : 'ninguno'})`));
    fail('Ninguna página está vinculada a esa cuenta de Instagram. Al generar el token corto, marca la página de Kinda en el selector.');
  }
  console.log(`    Página: ${page.name}`);

  console.log('3/5 Revisando vencimiento y permisos...');
  const dbg = (await graph(`debug_token?input_token=${encodeURIComponent(page.access_token)}` +
    `&access_token=${encodeURIComponent(appId + '|' + appSecret)}`)).data || {};
  const scopes = dbg.scopes || [];
  const missing = NEEDED.filter(s => !scopes.includes(s));
  if (!dbg.is_valid) fail('Meta dice que el token no es válido.');
  if (missing.length) fail(`Faltan permisos: ${missing.join(', ')}. Agrégalos en Graph API Explorer y genera el token de nuevo.`);
  const never = !dbg.expires_at;
  console.log(`    Vence: ${never ? 'nunca' : new Date(dbg.expires_at * 1000).toLocaleDateString('es-CL')}`);
  OPTIONAL.filter(s => !scopes.includes(s)).forEach(s => console.log(`    ⚠ Falta ${s}: el agente publica, pero no podrá leer métricas.`));

  console.log('4/5 Probando el token con la cuenta de Instagram...');
  const ig = await graph(`${page.instagram_business_account.id}?fields=username&access_token=${encodeURIComponent(page.access_token)}`);
  console.log(`    OK: @${ig.username}`);

  console.log('5/5 Guardando en GitHub Secrets y config.js...');
  const gh = spawnSync('gh', ['secret', 'set', 'META_ACCESS_TOKEN', '--repo', REPO], { input: page.access_token, encoding: 'utf8' });
  if (gh.status !== 0) fail('No se pudo guardar en GitHub: ' + (gh.stderr || gh.error));
  if (fs.existsSync(configPath)) {
    const c = fs.readFileSync(configPath, 'utf8');
    if (/metaAccessToken:\s*'[^']*'/.test(c)) fs.writeFileSync(configPath, c.replace(/metaAccessToken:\s*'[^']*'/, () => `metaAccessToken: '${page.access_token}'`), 'utf8');
  }

  console.log(`\n✅ Listo. Token de página guardado (${never ? 'no vence' : 'ojo: este sí vence'}).`);
  console.log('   Para probar: gh workflow run daily-post.yml --repo ' + REPO);
}

main().catch(e => fail(e.message));
