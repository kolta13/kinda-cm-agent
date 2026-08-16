'use strict';
const https  = require('https');
const config = require('./config');

function get(path) {
  return new Promise((resolve, reject) => {
    const url = `https://graph.facebook.com/v21.0${path}&access_token=${config.metaAccessToken}`;
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== Permisos del token ===');
  const perms = await get('/me/permissions?');
  perms.data?.forEach(p => console.log(` ${p.status === 'granted' ? '✓' : '✗'} ${p.permission}`));

  console.log('\n=== /me/accounts (raw) ===');
  const accounts = await get('/me/accounts');
  console.log(JSON.stringify(accounts, null, 2));

  console.log('\n=== Página directa ===');
  const page = await get('/61593066975440?fields=id,name,instagram_business_account');
  console.log(JSON.stringify(page, null, 2));
}

main().catch(e => console.error(e.message));
