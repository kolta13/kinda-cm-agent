'use strict';
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const config = require('./config');

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data   = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout:  30000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const dataPath = path.join(__dirname, 'data', 'carousel_latest.json');
  const data     = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const carousel = data.carousel;

  const slidesSummary = carousel.slides
    .filter(s => s.tipo !== 'cta')
    .map(s => `- ${s.titulo}${s.body ? ': ' + s.body.slice(0, 80) : ''}`)
    .join('\n');

  const prompt = `Eres community manager de Kinda Club (kindaclub.com), red para músicos independientes de LATAM.

Tema del carrusel: "${carousel.tema}"

Puntos del carrusel:
${slidesSummary}

Escribe el caption para Instagram. Requisitos:
- Tono directo y humano, como un músico que sabe del tema hablando con un colega. Sin "¡Atención músicos!", sin frases motivacionales vacías, sin exageración de marketing.
- Máximo 3 líneas de texto corrido. Que enganchen sin gritar.
- 1 línea en blanco.
- Exactamente 4 hashtags en la última línea. Estrategia: 1 hashtag amplio con alto volumen de búsqueda en LATAM (ej: #Musicos, #MusicaLatina), 2 hashtags de nicho con audiencia comprometida relacionados con el tema exacto del carrusel, 1 hashtag de marca (#KindaClub). Prioriza hashtags que realmente usa la comunidad de músicos independientes en Instagram.
- Emojis opcionales, máximo 2-3, solo si suman.
- En español latino neutro. Sin voseo ni modismos argentinos: nada de "che", "guita", "laburo", "boludo", "pibe", "re ", "copado". Usar "tú/tienes", "dinero/plata", "trabajo", etc.

Responde SOLO con el caption, sin comillas ni explicaciones.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${config.geminiApiKey}`;
  const res  = await httpPost(url, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.8 },
  });

  let caption = res.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!caption) throw new Error('Gemini no devolvió caption');
  // Eliminar signos de exclamación y voseo que pudieran escaparse
  caption = caption.replace(/¡/g, '').replace(/!/g, '.').replace(/\.{2,}/g, '.');

  console.log('\n── Caption generado ──────────────────────\n');
  console.log(caption);
  console.log('\n──────────────────────────────────────────\n');

  // Actualizar carousel_latest.json
  carousel.caption_instagram = caption;
  data.carousel = carousel;
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
  console.log('✅ carousel_latest.json actualizado');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
