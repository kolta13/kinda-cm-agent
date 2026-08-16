'use strict';
const ftp = require('basic-ftp');
const config = require('./config');

async function check() {
  const client = new ftp.Client(30000);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: config.ftpHost, user: config.ftpUser,
      password: config.ftpPass, secure: false,
    });
    console.log('Directorio raíz FTP:');
    const root = await client.list('/');
    root.forEach(f => console.log(` ${f.type === 2 ? 'd' : '-'} ${f.name}`));

    // Ver si existe public_html
    try {
      const ph = await client.list('/public_html');
      console.log('\n/public_html:');
      ph.forEach(f => console.log(` ${f.type === 2 ? 'd' : '-'} ${f.name}`));
    } catch(e) { console.log('\n/public_html no accesible:', e.message); }

  } finally { client.close(); }
}
check().catch(e => console.error(e.message));
