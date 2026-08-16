'use strict';
const ftp  = require('basic-ftp');
const path = require('path');
const config = require('./config');

async function upload() {
  const client = new ftp.Client(30000);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: config.ftpHost, user: config.ftpUser,
      password: config.ftpPass, secure: false,
    });
    // La raíz FTP del usuario asistente@ sirve en kindagrowth.cl/asistente/
    // Los archivos ahí se sirven estáticos (api.php, index.html ya funcionan)
    const local = path.join(__dirname, 'template', 'privacy-policy.html');
    await client.uploadFrom(local, '/privacy.html');
    console.log('✅ Subido → https://kindagrowth.cl/asistente/privacy.html');
  } finally { client.close(); }
}

upload().catch(e => { console.error('Error FTP:', e.message); process.exit(1); });
