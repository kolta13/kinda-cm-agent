'use strict';
const puppeteer = require('puppeteer');
const fs   = require('fs');
const path = require('path');

const TEMPLATE   = path.join(__dirname, 'template', 'icon.html');
const ASSETS_DIR = path.join(__dirname, 'assets');
const OUT        = path.join(__dirname, 'assets', 'app-icon-512.png');

async function renderIcon() {
  const logoPath = path.join(ASSETS_DIR, 'logo-inline.png');
  const logoB64  = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 2 });

  const url = 'file:///' + TEMPLATE.replace(/\\/g, '/');
  await page.goto(url, { waitUntil: 'networkidle0' });

  await page.evaluate((src) => {
    document.getElementById('logo-img').src = src;
  }, logoB64);

  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: OUT, type: 'png', clip: { x: 0, y: 0, width: 512, height: 512 } });
  await browser.close();

  console.log('✅ Ícono generado:', OUT);
}

renderIcon().catch(e => { console.error(e); process.exit(1); });
