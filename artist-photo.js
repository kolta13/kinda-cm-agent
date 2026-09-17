// ── Kinda CM Agent — Foto real de artista (Wikimedia Commons) ───────────
// Para posts de "caso real" sobre un artista específico (ej. Kidd Voodoo),
// el usuario pidió que la portada muestre al artista mismo en vez de una
// foto de stock genérica.
//
// Se investigaron 5+ fuentes antes de elegir esta (2026-09-17):
//   - Spotify Web API: descartada — sus términos prohíben poner texto/logo
//     encima de imágenes de la API y exigen link de vuelta a Spotify, algo
//     que nuestro render (que overlaya título/kicker/logo) viola directo.
//   - Búsqueda general en la web (Google Images): descartada — cero licencia
//     de reuso, el mayor riesgo legal de todas las opciones evaluadas.
//   - Discogs API: descartada — distingue datos CC0 de "Restricted Data", y
//     la mayoría de fotos de artista caen en la segunda categoría, con uso
//     comercial explícitamente prohibido.
//   - TheAudioDB: riesgo medio — tiene un campo strCreativeCommons, pero es
//     autodeclarado por quien subió la foto, sin verificación real.
//   - Genius API: descartada por falta de info confiable sobre sus términos.
//   - Wikimedia Commons (ESTA): única fuente con licencia CC explícita y
//     verificada por moderación comunitaria activa, no autodeclarada. Limitación
//     real y conocida: poca cobertura de artistas emergentes/regionales — para
//     un artista chileno urbano recién despegando, es esperable no encontrar
//     nada. Por eso SIEMPRE se hace fallback a la foto de stock genérica si
//     Commons no tiene nada, nunca se bloquea el render por esto.
//
// RIESGO REAL DESCUBIERTO (2026-09-17) — LEER ANTES DE AUTOMATIZAR MÁS:
// buscar "Kidd Voodoo" devolvió una foto real, con licencia válida, de una
// persona LLAMADA "Kidd Voodoo" tocando en el Montreux Jazz Festival 2026 —
// pero al compararla con fotos de prensa reales del Kidd Voodoo chileno
// (Remezcla), el aspecto no calzaba obviamente (lentes, look de banda indie,
// vs. estética urbana de las fotos de prensa). Nombres de artista NO son
// identificadores únicos — puede haber otra persona/banda con el mismo
// nombre. La página de Commons de cada foto de persona además trae su propia
// advertencia: "the person(s) shown may have rights that legally restrict
// certain re-uses unless those depicted consent" (personality rights).
//
// Por esto, esta función SOLO debe usarse para encontrar una CANDIDATA que
// un humano confirma visualmente antes de publicar — NUNCA para embeber la
// foto directo en un render automático sin supervisión (por eso NO está
// conectada a render.js todavía). Usar mal esto significa mostrar a una
// persona real, con su nombre real, como si fuera alguien que no es.
//
// Uso: const { fetchArtistPhoto } = require('./artist-photo');
// (revisar el resultado con un humano antes de usarlo en cualquier post)

'use strict';
const https = require('https');

const COMMONS_API = 'commons.wikimedia.org';
const USER_AGENT = 'KindaCMAgent/1.0 (kindaclub.com; kindamusic.mkt@gmail.com)';

// Nombres de archivo que casi seguro NO son una foto de la persona (logos,
// firmas, portadas de disco, pósters) — se descartan aunque tengan buena
// licencia, porque no cumplen lo que pidió el usuario ("imagen del artista").
const NOT_A_PHOTO_RE = /logo|signature|_sig\.|firma|portada|album cover|cover art|poster|flag|coat of arms|map of|diagram|qr code|wordmark/i;

function httpsGetJson(hostname, reqPath) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: reqPath, headers: { 'User-Agent': USER_AGENT }, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('Respuesta no es JSON de Commons')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('Timeout Commons API')); });
  });
}

function downloadAsBase64(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve('data:image/jpeg;base64,' + Buffer.concat(chunks).toString('base64')));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('Timeout descargando imagen')); });
  });
}

// Busca una foto real del artista en Wikimedia Commons. Devuelve
// { base64, title, author, license, sourceUrl } o null si no encuentra nada
// que cumpla los filtros (nunca lanza error por "no encontrado" — eso es un
// resultado válido, el llamador debe caer a la foto de stock genérica).
async function fetchArtistPhoto(artistName) {
  if (!artistName) return null;

  // Verificado en vivo (2026-09-17): una query con "OR" tipo "X singer OR
  // musician OR performing" NO hace lo esperado en CirrusSearch — el término
  // del artista queda tan diluido entre los OR que devuelve resultados sin
  // ninguna relación (probado con "Bad Bunny", trajo una foto de un acordeonista
  // en Quito). Buscar el nombre como intitle:"..." exacto sí funciona: todos los
  // resultados reales de Commons tienen el nombre del artista en el filename.
  const query = `intitle:"${artistName}"`;
  const searchPath = `/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}` +
    `&gsrnamespace=6&gsrlimit=15&prop=imageinfo&iiprop=url|extmetadata|mime|size` +
    `&iiurlwidth=1080&format=json`;

  let data;
  try {
    data = await httpsGetJson(COMMONS_API, searchPath);
  } catch (e) {
    console.warn(`[artist-photo] Búsqueda en Commons falló para "${artistName}": ${e.message}`);
    return null;
  }

  const pages = Object.values(data.query?.pages || {});
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info) continue;

    const title = page.title || '';
    if (NOT_A_PHOTO_RE.test(title)) continue;
    if (!info.mime || !info.mime.startsWith('image/') || info.mime === 'image/svg+xml') continue;
    if ((info.width || 0) < 400 || (info.height || 0) < 400) continue; // evitar íconos/miniaturas

    const license = info.extmetadata?.LicenseShortName?.value;
    if (!license) continue; // sin licencia clara, no se usa

    const imgUrl = info.thumburl || info.url;
    if (!imgUrl) continue;

    try {
      const base64 = await downloadAsBase64(imgUrl);
      const author = (info.extmetadata?.Artist?.value || '').replace(/<[^>]+>/g, '').trim();
      console.log(`[artist-photo] ✓ Candidata encontrada para "${artistName}" (REQUIERE CONFIRMACIÓN VISUAL HUMANA — el nombre puede coincidir con otra persona): ${title} (${license}, autor: ${author || '?'})`);
      return { base64, title, author, license, sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}` };
    } catch (e) {
      console.warn(`[artist-photo] No se pudo descargar "${title}": ${e.message}`);
      continue; // probar el siguiente resultado
    }
  }

  console.log(`[artist-photo] Sin foto real utilizable en Commons para "${artistName}" — se usa foto de stock genérica.`);
  return null;
}

module.exports = { fetchArtistPhoto };
