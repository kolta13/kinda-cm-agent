// ── Kinda CM Agent — Dossier de investigación de "caso de artista" ──────
// Automatiza el trabajo pesado de investigación para posts de caso real
// (ej. Kidd Voodoo 2023) UNA VEZ que un humano ya decidió qué artista y qué
// año contar — la detección de "quién vale la pena" sigue siendo manual/
// orgánica a propósito (Chartmetric/Soundcharts cuestan USD 250-350/mes y
// el usuario decidió no pagar eso por ahora; ver notas del 2026-09-17).
//
// Este script NUNCA escribe en data/backlog.json ni llama a nada del
// pipeline automático — solo imprime y guarda un dossier standalone para
// que un humano lo revise, elija el candidato correcto y arme a mano el
// JSON que alimenta add-to-backlog.js. Mismo patrón exacto que se usó hoy
// para Kidd Voodoo, con la investigación automatizada.
//
// Qué SÍ automatiza:
//   - Discografía real de Spotify para el año pedido (conteo de lanzamientos
//     y colaboraciones) — metadata pública, nunca imágenes de Spotify.
//   - Candidatos de noticias/entrevistas reales (vía Serper News, sin
//     restricción de fecha) para que el humano abra el link y cite a mano.
//   - Foto candidata de Wikimedia Commons (reusa artist-photo.js tal cual).
//
// Selección de artista de Spotify cuando hay varios con nombre parecido:
// SIEMPRE se listan todos los candidatos con sus seguidores, y se usa el de
// más seguidores automáticamente, sin pedir confirmación (decisión explícita
// del usuario, 2026-09-17) — en la práctica el candidato real queda muy por
// delante de cualquier homónimo (visto en vivo con Kidd Voodoo: 1.3M vs. unos
// pocos cientos de seguidores). El dossier igual muestra la lista completa
// por si el humano quiere revisarla.
//
// Qué NUNCA hace (a propósito):
//   - Pedirle a Gemini (o a cualquier IA) que extraiga o redacte una cita
//     de entrevista. Fabricar una cita atribuida a una persona real es un
//     riesgo más serio que el de cifras infladas que ya cubre la REGLA #1b
//     de generate.js — el humano tiene que abrir el link y copiar el texto
//     exacto.
//   - Confirmar la foto de artista por sí solo — sigue exactamente el gate
//     de artist-photo.js (candidata para revisión humana, nunca auto-uso).
//
// Uso: node artist-research.js "Nombre del artista" 2023 [market]
// (market opcional, código ISO de 2 letras, default CL)

'use strict';
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const config  = require('./config');
const { fetchArtistPhoto } = require('./artist-photo');
const { searchSerperNews } = require('./research');

const DATA_DIR = path.join(__dirname, 'data');

// ── HTTP helpers ─────────────────────────────────────────────────────────

function httpsPostForm(hostname, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, path: reqPath, method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

function httpsGetPlain(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (KindaCMAgent research tool)' }, timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('Timeout')); });
  });
}

function httpsGetAuth(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search,
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Spotify: Client Credentials (gratis, self-serve) ────────────────────
// Cache solo en memoria — este script se corre a mano, una vez por artista/
// año, no hace falta persistir el token entre corridas distintas.

let cachedToken = null;

async function getSpotifyToken() {
  if (!config.spotifyClientId || !config.spotifyClientSecret) {
    throw new Error('Configura spotifyClientId/spotifyClientSecret en config.js — https://developer.spotify.com/dashboard');
  }
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) return cachedToken.access_token;

  const creds = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64');
  const raw = await httpsPostForm('accounts.spotify.com', '/api/token', 'grant_type=client_credentials', {
    Authorization: `Basic ${creds}`,
  });
  const data = JSON.parse(raw);
  if (!data.access_token) throw new Error('Spotify auth falló: ' + JSON.stringify(data));
  cachedToken = { access_token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.access_token;
}

// Busca artistas por nombre. Devuelve TODOS los candidatos (Spotify indexa
// muchos artistas con nombres iguales o parecidos) para que el dossier los
// muestre — buildDossier() usa automáticamente el de más seguidores, ver
// nota al inicio del archivo.
async function findSpotifyArtist(name, token) {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=artist&limit=5`;
  const raw = await httpsGetAuth(url, token);
  const data = JSON.parse(raw);
  return (data.artists?.items || []).map(a => ({
    id:         a.id,
    name:       a.name,
    followers:  a.followers?.total ?? null,
    genres:     a.genres || [],
    popularity: a.popularity ?? null,
    spotifyUrl: a.external_urls?.spotify || '',
  }));
}

// Trae toda la discografía relacionada al artista (paginado) y cuenta lo del
// año pedido. Metadata pública únicamente — nunca se descargan imágenes.
async function getArtistReleasesForYear(artistId, year, token, market) {
  const groups = 'album,single,appears_on'; // sin 'compilation': evita contar recopilatorios como lanzamiento nuevo
  let url = `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=${groups}&market=${market}&limit=50`;
  const all = [];

  while (url) {
    const raw  = await httpsGetAuth(url, token);
    const page = JSON.parse(raw);
    if (page.error) throw new Error(`Spotify albums: ${page.error.message}`);
    all.push(...(page.items || []));
    url = page.next; // Spotify da la URL absoluta de la siguiente página
  }

  // Dedupe: Spotify repite el mismo lanzamiento como entradas separadas por
  // disponibilidad regional — se agrupa por (nombre normalizado, fecha).
  const seen = new Set();
  const deduped = all.filter(item => {
    const key = `${(item.name || '').trim().toLowerCase()}__${item.release_date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const yearStr = String(year);
  const inYear = deduped.filter(item => (item.release_date || '').startsWith(yearStr));
  const yearOnlyPrecision = inYear.filter(item => item.release_date_precision === 'year');

  const ownReleasesWithCollaborators = [];
  const appearsOn = [];
  const collaboratorNames = new Set();
  const byType = { album: 0, single: 0 };

  for (const item of inYear) {
    if (item.album_group === 'appears_on') {
      const primary = (item.artists || []).find(a => a.id !== artistId);
      appearsOn.push({ name: item.name, release_date: item.release_date, primaryArtist: primary?.name || '?' });
      (item.artists || []).forEach(a => { if (a.id !== artistId) collaboratorNames.add(a.name); });
      continue;
    }
    if (item.album_type === 'album') byType.album++;
    else if (item.album_type === 'single') byType.single++;

    const others = (item.artists || []).filter(a => a.id !== artistId).map(a => a.name);
    if (others.length > 0) {
      ownReleasesWithCollaborators.push({ name: item.name, release_date: item.release_date, type: item.album_type, collaborators: others });
      others.forEach(n => collaboratorNames.add(n));
    }
  }

  return {
    totalReleases: inYear.length,
    byType,
    ownReleasesWithCollaborators,
    appearsOn,
    distinctCollaboratorNames: [...collaboratorNames],
    yearOnlyPrecisionCount: yearOnlyPrecision.length, // fechas sin mes/día confirmado, ver aviso en el dossier
  };
}

// ── kworb.net: historial de charts (gratis, sin login, desde 2014) ──────
// Datos comunitarios no oficiales — de acceso público hace más de una década
// y ampliamente usados para investigación (ver hallazgos del 2026-09-17: no
// hay ninguna fuente gratuita de historial de crecimiento oficial de Spotify;
// esta es la más completa y verificable que se encontró). Se usa el ID de
// Spotify que YA se resolvió arriba, no un nombre nuevo — no agrega ningún
// riesgo de identidad adicional al ya cubierto por findSpotifyArtist().
// Cualquier cifra de acá debería poder cruzarse con otra fuente antes de
// publicarse, como cualquier dato de REGLA #1b.

function stripTags(s) { return s.replace(/<[^>]+>/g, '').trim(); }

function parseKworbTable(html) {
  const theadMatch = html.match(/<thead>([\s\S]*?)<\/thead>/);
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!theadMatch || !tbodyMatch) return null;
  const headers = [...theadMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => stripTags(m[1]));
  const rows = [...tbodyMatch[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(rowMatch =>
    [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => stripTags(m[1]))
  );
  return { headers, rows };
}

async function getKworbChartHistory(spotifyArtistId, year, market) {
  const url = `https://kworb.net/spotify/artist/${spotifyArtistId}.html`;
  let html;
  try {
    html = await httpsGetPlain(url);
  } catch (e) {
    return { available: false, note: `kworb.net no respondió: ${e.message}` };
  }
  if (!html.includes('<table')) {
    return { available: false, note: 'Sin historial de charts en kworb.net para este artista (o no existe la página).' };
  }

  const table = parseKworbTable(html);
  if (!table) return { available: false, note: 'No se pudo interpretar la tabla de kworb.net.' };

  const idxDate   = table.headers.indexOf('Peak Date');
  const idxTitle  = table.headers.indexOf('Title');
  const idxGlobal = table.headers.indexOf('Global');
  const idxMarket = table.headers.indexOf(market);

  if (idxMarket === -1) {
    return { available: true, chartedInMarket: false, sourceUrl: url,
      note: `El artista no tiene historial de chart registrado en el mercado "${market}" según kworb.net.` };
  }

  const yearStr = String(year);
  const entriesInYear = table.rows
    .map(r => ({ peakDate: r[idxDate], title: r[idxTitle], globalPeak: r[idxGlobal], marketPeak: r[idxMarket] }))
    .filter(e => e.peakDate && e.peakDate.startsWith(yearStr) && e.marketPeak && e.marketPeak !== '--');

  return {
    available: true,
    chartedInMarket: true,
    sourceUrl: url,
    entriesInYear,
    top50CountInYear: entriesInYear.filter(e => Number(e.marketPeak) <= 50).length,
  };
}

// ── Dossier ──────────────────────────────────────────────────────────────

async function buildDossier(artistName, year, market = 'CL') {
  const dossier = {
    artist_name_queried: artistName,
    year,
    market,
    generated_at: new Date().toISOString(),
    spotify_candidates: [],
    spotify_error: null,
    discography: null,
    chart_history: null,
    news_candidates: [],
    photo_candidate: null,
  };

  // Spotify — candidatos + discografía del candidato más popular (marcado
  // como "sin confirmar", el humano debe validar cuál es el correcto)
  try {
    const token = await getSpotifyToken();
    dossier.spotify_candidates = await findSpotifyArtist(artistName, token);
    const best = [...dossier.spotify_candidates].sort((a, b) => (b.followers || 0) - (a.followers || 0))[0];
    if (best) {
      dossier.discography = await getArtistReleasesForYear(best.id, year, token, market);
      dossier.discography.usedCandidateId = best.id;
      dossier.discography.usedCandidateName = best.name;

      // kworb.net usa el MISMO id de Spotify que ya se resolvió arriba — no
      // agrega ningún riesgo de identidad nuevo.
      try {
        dossier.chart_history = await getKworbChartHistory(best.id, year, market);
      } catch (e) {
        dossier.chart_history = { available: false, note: `kworb.net falló: ${e.message}` };
      }
    }
  } catch (e) {
    dossier.spotify_error = e.message;
  }

  // Noticias/entrevistas — sin restricción de fecha (tbs=null), a diferencia
  // del research.js diario que solo mira la última semana.
  try {
    const [r1, r2] = await Promise.all([
      searchSerperNews(`"${artistName}" entrevista`, 5, null),
      searchSerperNews(`"${artistName}" ${year}`, 5, null),
    ]);
    const seenUrls = new Set();
    dossier.news_candidates = [...r1, ...r2].filter(n => {
      if (!n.url || seenUrls.has(n.url)) return false;
      seenUrls.add(n.url);
      return true;
    });
  } catch (e) {
    console.warn('[artist-research] Búsqueda de noticias falló:', e.message);
  }

  // Foto candidata — reusa artist-photo.js tal cual, mismo gate de siempre.
  try {
    const photo = await fetchArtistPhoto(artistName);
    if (photo) dossier.photo_candidate = { title: photo.title, author: photo.author, license: photo.license, sourceUrl: photo.sourceUrl, base64: photo.base64 };
  } catch (e) {
    console.warn('[artist-research] Búsqueda de foto falló:', e.message);
  }

  return dossier;
}

// ── Presentación ─────────────────────────────────────────────────────────

function printDossier(d) {
  console.log(`\n[artist-research] Dossier para "${d.artist_name_queried}" — ${d.year} (mercado ${d.market})\n`);

  console.log('── SPOTIFY: posibles coincidencias ──');
  if (d.spotify_error) {
    console.log(`  ⚠ ${d.spotify_error}`);
  } else if (d.spotify_candidates.length === 0) {
    console.log('  Sin resultados.');
  } else {
    d.spotify_candidates.forEach((c, i) => {
      const usado = d.discography?.usedCandidateId === c.id ? ' ← usado' : '';
      console.log(`  ${i + 1}. ${c.name} — ${c.followers?.toLocaleString('es-CL') ?? '?'} seguidores, géneros: [${c.genres.join(', ') || '?'}]${usado}`);
      console.log(`     ${c.spotifyUrl}`);
    });
    // Decisión explícita del usuario (2026-09-17): usar siempre el candidato
    // con más seguidores, sin pedir confirmación manual — a diferencia de la
    // foto de Wikimedia Commons (sin señal de desempate como "seguidores" y
    // donde ya se confirmó en vivo que el nombre solo trae a la persona
    // equivocada), acá el conteo de seguidores es una señal fuerte: en la
    // práctica el candidato real queda muy por delante de cualquier homónimo.
  }

  if (d.discography) {
    console.log(`\n── DISCOGRAFÍA ${d.year} (usando candidato: ${d.discography.usedCandidateName}) ──`);
    console.log(`  Total lanzamientos: ${d.discography.totalReleases} (${d.discography.byType.album} álbumes, ${d.discography.byType.single} singles)`);
    if (d.discography.ownReleasesWithCollaborators.length > 0) {
      console.log(`  Colaboraciones propias: ${d.discography.ownReleasesWithCollaborators.length}`);
      d.discography.ownReleasesWithCollaborators.forEach(r => console.log(`    - "${r.name}" con ${r.collaborators.join(', ')}`));
    }
    if (d.discography.appearsOn.length > 0) {
      console.log(`  Apariciones en lanzamientos de otros: ${d.discography.appearsOn.length}`);
      d.discography.appearsOn.forEach(r => console.log(`    - "${r.name}" (de ${r.primaryArtist})`));
    }
    if (d.discography.distinctCollaboratorNames.length > 0) {
      console.log(`  Artistas colaboradores distintos: ${d.discography.distinctCollaboratorNames.join(', ')}`);
    }
    if (d.discography.yearOnlyPrecisionCount > 0) {
      console.log(`  ⚠ ${d.discography.yearOnlyPrecisionCount} lanzamiento(s) con fecha de precisión "solo año" — no se puede confirmar el mes exacto.`);
    }
  }

  if (d.chart_history) {
    console.log(`\n── HISTORIAL DE CHARTS ${d.year}, mercado ${d.market} (kworb.net, dato comunitario no oficial) ──`);
    if (!d.chart_history.available) {
      console.log(`  ⚠ ${d.chart_history.note}`);
    } else if (!d.chart_history.chartedInMarket) {
      console.log(`  ${d.chart_history.note}`);
    } else if (d.chart_history.entriesInYear.length === 0) {
      console.log(`  Sin canciones con peak en ${d.market} durante ${d.year}.`);
    } else {
      console.log(`  Canciones que entraron al Top 50 de ${d.market} en ${d.year}: ${d.chart_history.top50CountInYear}`);
      d.chart_history.entriesInYear.forEach(e => console.log(`    - "${e.title}" — peak #${e.marketPeak} en ${d.market} (${e.peakDate})`));
      console.log(`  Fuente: ${d.chart_history.sourceUrl}`);
      console.log('  ⚠ Dato comunitario no oficial — cruzar con otra fuente antes de citarlo como cifra dura.');
    }
  }

  console.log('\n── NOTICIAS/ENTREVISTAS (leer y citar manualmente) ──');
  if (d.news_candidates.length === 0) {
    console.log('  Sin resultados.');
  } else {
    d.news_candidates.forEach((n, i) => {
      console.log(`  ${i + 1}. "${n.title}" — ${n.url}`);
      if (n.description) console.log(`     "${n.description}"`);
    });
    console.log('  ⚠ Ninguna cita debe usarse sin abrir el link y confirmar el texto exacto.');
  }

  console.log('\n── FOTO CANDIDATA (Wikimedia Commons) ──');
  if (d.photo_candidate) {
    console.log(`  Título: ${d.photo_candidate.title}`);
    console.log(`  Licencia: ${d.photo_candidate.license} | Autor: ${d.photo_candidate.author || '?'}`);
    console.log(`  URL: ${d.photo_candidate.sourceUrl}`);
    console.log('  ⚠ REQUIERE CONFIRMACIÓN VISUAL HUMANA contra fotos de prensa reales antes de usarla (ver artist-photo.js).');
  } else {
    console.log('  Sin foto candidata en Commons — usar foto de stock genérica.');
  }

  console.log('\n── SIGUIENTE PASO ──');
  console.log('  1. Confirma cuál candidato de Spotify es el artista correcto.');
  console.log('  2. Abre las noticias de arriba y copia una cita real si la usarás.');
  console.log('  3. Compara la foto candidata contra fotos de prensa reales.');
  console.log('  4. Escribe a mano el campo "description" citando estos datos.');
  console.log('  5. Corre: node add-to-backlog.js ideas.json\n');
}

function slugify(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function saveDossier(d) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const toSave = { ...d, photo_candidate: d.photo_candidate ? { ...d.photo_candidate, base64: undefined } : null };
  const filePath = path.join(DATA_DIR, `research_dossier_${slugify(d.artist_name_queried)}_${d.year}.json`);
  fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf8');
  console.log(`[artist-research] Dossier guardado en ${filePath}`);

  if (d.photo_candidate?.base64) {
    const imgPath = path.join(DATA_DIR, `photo_candidate_${slugify(d.artist_name_queried)}.jpg`);
    fs.writeFileSync(imgPath, Buffer.from(d.photo_candidate.base64.split(',')[1], 'base64'));
    console.log(`[artist-research] Foto candidata guardada en ${imgPath} (revisar antes de usar)`);
  }
}

// ── Ejecución directa ─────────────────────────────────────────────────────

async function main() {
  const [artistName, yearArg, market] = process.argv.slice(2);
  if (!artistName || !yearArg) {
    console.log('Uso: node artist-research.js "Nombre del artista" 2023 [market]');
    console.log('  market: código ISO de 2 letras, default CL');
    process.exit(0);
  }
  const dossier = await buildDossier(artistName, Number(yearArg), market || 'CL');
  printDossier(dossier);
  saveDossier(dossier);
}

if (require.main === module) {
  main().catch(e => { console.error('[artist-research] Error:', e.message); process.exit(1); });
}

module.exports = { buildDossier };
