// ── Kinda CM Agent — Fase 1: Research ───────────────────────────────────
// Busca tendencias del rubro musical en LATAM desde múltiples fuentes:
//   - Google Search (Serper) + People Also Ask
//   - Videos virales de TikTok / YouTube Shorts (vía Serper Videos)
//   - Noticias recientes de la industria (vía Serper News)
//   - YouTube Data API v3
//
// Todas las ideas nuevas se agregan al backlog persistente (data/backlog.json).
// Output: data/research_latest.json (compatible con versiones anteriores)
//
// Uso: node research.js

'use strict';
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const config  = require('./config');
const backlog = require('./backlog');

// ── Queries por categoría ─────────────────────────────────────────────────
// Se rotan diariamente para cubrir distintos ángulos sin repetirse.

const GOOGLE_QUERIES = [
  'cómo lanzar una canción en spotify 2025',
  'cómo crecer en spotify como artista independiente',
  'cómo conseguir playlists editoriales spotify',
  'marketing digital para músicos independientes',
  'cómo monetizar música en streaming',
  'distribución musical independiente latinoamérica',
  'cómo hacer crecer fanbase músico',
  'estrategia tiktok para artistas musicales',
  'cómo conseguir booking conciertos independiente',
  'errores comunes músicos independientes',
  'cómo negociar con un sello discográfico',
  'royalties streaming cuánto se gana',
  'sync licensing música para publicidad',
  'cómo hacer un videoclip bajo presupuesto',
  'productores musicales emergentes latinoamérica',
  'cómo vivir de la música sin sello discográfico',
  'redes sociales para músicos qué funciona',
  'contratos musicales cláusulas importantes',
  'cómo hacer un press kit músico independiente',
  'colaboraciones musicales cómo conseguirlas',
];

const VIDEO_QUERIES = [
  'músico independiente consejos tiktok viral',
  'artista emergente estrategia spotify viral',
  'cómo monetizar música independiente tiktok',
  'errores músicos independientes viral',
  'crecer en spotify artista sin sello tiktok',
];

const NEWS_QUERIES = [
  'industria musical latinoamerica 2025',
  'spotify noticias artistas independientes',
  'tiktok música tendencias artistas',
  'derechos musicales streaming noticias',
  'músicos independientes tendencias latam',
];

const YOUTUBE_QUERIES = [
  'músico independiente consejos 2025',
  'cómo vivir de la música sin sello',
  'marketing musical artista emergente',
  'spotify for artists estrategia',
  'cómo crecer en tiktok siendo músico',
];

// ── Helpers HTTP ──────────────────────────────────────────────────────────

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 12000, headers: { 'User-Agent': 'KindaCMAgent/1.0', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname,
      method:   'POST',
      timeout:  12000,
      headers:  { 'User-Agent': 'KindaCMAgent/1.0', 'Content-Length': Buffer.byteLength(body), ...headers },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Timeout')));
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Rotación diaria: cada día usa un subconjunto distinto del pool
function getDailyQueries(pool, n) {
  const today  = new Date();
  const dayNum = Math.floor(today.getTime() / 86400000); // días desde epoch
  const offset = (dayNum * n) % pool.length;
  const slice  = pool.slice(offset, offset + n);
  if (slice.length < n) slice.push(...pool.slice(0, n - slice.length));
  return slice;
}

function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^a-záéíóúüñ0-9\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// ── Serper: Google Search ─────────────────────────────────────────────────

async function searchSerper(query, limit = 4) {
  if (!config.serperApiKey) return { organic: [], paa: [] };

  const body = JSON.stringify({ q: query, gl: 'cl', hl: 'es', num: limit, tbs: 'qdr:m6' });
  let raw;
  try {
    raw = await httpPost('https://google.serper.dev/search', body, {
      'X-API-KEY': config.serperApiKey, 'Content-Type': 'application/json',
    });
  } catch (e) { console.warn(`[research] Serper error "${query}":`, e.message); return { organic: [], paa: [] }; }

  const data = JSON.parse(raw);
  if (data.error) { console.warn('[research] Serper error:', data.error); return { organic: [], paa: [] }; }

  const organic = (data.organic || []).slice(0, limit).map(r => ({
    title:       (r.title   || '').trim(),
    description: (r.snippet || '').trim(),
    url:         r.link || '',
    source:      'google',
  }));

  // People Also Ask: preguntas que realmente hace la audiencia en Google
  const paa = (data.peopleAlsoAsk || []).slice(0, 3).map(r => ({
    title:       (r.question || '').trim(),
    description: (r.snippet  || '').trim(),
    url:         r.link || '',
    source:      'google_paa',
  }));

  return { organic, paa };
}

// ── Serper: Videos virales (TikTok / YouTube Shorts / YouTube) ────────────

async function searchSerperVideos(query, limit = 4) {
  if (!config.serperApiKey) return [];

  const body = JSON.stringify({ q: query, gl: 'us', hl: 'es', num: limit, tbs: 'qdr:m' });
  let raw;
  try {
    raw = await httpPost('https://google.serper.dev/videos', body, {
      'X-API-KEY': config.serperApiKey, 'Content-Type': 'application/json',
    });
  } catch (e) { console.warn(`[research] Serper videos error "${query}":`, e.message); return []; }

  const data = JSON.parse(raw);
  if (data.error) { console.warn('[research] Serper videos error:', data.error); return []; }

  return (data.videos || []).slice(0, limit)
    .filter(v => v.title && v.title.length > 5)
    .map(v => ({
      title:       (v.title   || '').trim(),
      description: (v.snippet || v.channel || '').trim(),
      url:         v.link || '',
      source:      (v.link || '').includes('tiktok') ? 'tiktok_viral' : 'youtube_viral',
    }));
}

// ── Serper: Noticias recientes de la industria ────────────────────────────

async function searchSerperNews(query, limit = 3) {
  if (!config.serperApiKey) return [];

  const body = JSON.stringify({ q: query, gl: 'us', hl: 'es', num: limit, tbs: 'qdr:w' }); // última semana
  let raw;
  try {
    raw = await httpPost('https://google.serper.dev/news', body, {
      'X-API-KEY': config.serperApiKey, 'Content-Type': 'application/json',
    });
  } catch (e) { console.warn(`[research] Serper news error "${query}":`, e.message); return []; }

  const data = JSON.parse(raw);
  if (data.error) { console.warn('[research] Serper news error:', data.error); return []; }

  return (data.news || []).slice(0, limit)
    .filter(n => n.title && n.title.length > 5)
    .map(n => ({
      title:       (n.title   || '').trim(),
      description: (n.snippet || '').trim(),
      url:         n.link || '',
      source:      'noticia',
      topic_tag:   'noticias',
    }));
}

// ── YouTube Data API v3 ──────────────────────────────────────────────────

async function searchYouTube(query, limit = 3) {
  if (!config.googleApiKey) return [];

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const params = new URLSearchParams({
    key:               config.googleApiKey,
    q:                 query,
    part:              'snippet',
    type:              'video',
    maxResults:        String(limit),
    order:             'viewCount',
    relevanceLanguage: 'es',
    publishedAfter:    sixMonthsAgo.toISOString().split('.')[0] + 'Z',
  });

  let raw;
  try { raw = await httpGet(`https://www.googleapis.com/youtube/v3/search?${params}`); }
  catch (e) { console.warn(`[research] YouTube error "${query}":`, e.message); return []; }

  const data = JSON.parse(raw);
  if (data.error) { console.warn('[research] YouTube API error:', data.error.message); return []; }

  return (data.items || [])
    .filter(i => i.id?.videoId)
    .map(i => ({
      title:       (i.snippet?.title       || '').trim(),
      description: (i.snippet?.description || '').trim(),
      url:         `https://youtube.com/watch?v=${i.id.videoId}`,
      source:      'youtube',
    }));
}

// ── Función principal ─────────────────────────────────────────────────────

async function research() {
  const allIdeas = [];
  const seen     = new Set();

  const addIdea = (r) => {
    if (!r.title || r.title.length < 5) return;
    const key = normalizeTitle(r.title);
    if (seen.has(key)) return;
    seen.add(key);
    allIdeas.push(r);
  };

  console.log('[research] Iniciando research diario...');

  // Google Search (2 queries rotativas hoy)
  const gQueries = getDailyQueries(GOOGLE_QUERIES, 2);
  console.log('[research] Google queries:', gQueries);
  for (const q of gQueries) {
    const { organic, paa } = await searchSerper(q, 4);
    organic.forEach(addIdea);
    paa.forEach(addIdea);
    console.log(`  ✓ Google "${q}" → ${organic.length} resultados + ${paa.length} PAA`);
    await sleep(300);
  }

  // Videos virales (1 query rotativa hoy: TikTok + YouTube)
  const vQuery = getDailyQueries(VIDEO_QUERIES, 1)[0];
  console.log('[research] Video query:', vQuery);
  const videos = await searchSerperVideos(vQuery, 5);
  videos.forEach(addIdea);
  console.log(`  ✓ Videos "${vQuery}" → ${videos.length} resultados`);
  await sleep(300);

  // Noticias recientes (1 query rotativa hoy)
  const nQuery = getDailyQueries(NEWS_QUERIES, 1)[0];
  console.log('[research] Noticias query:', nQuery);
  const news = await searchSerperNews(nQuery, 3);
  news.forEach(addIdea);
  console.log(`  ✓ Noticias "${nQuery}" → ${news.length} resultados`);
  await sleep(300);

  // YouTube (1 query rotativa hoy)
  const ytQuery = getDailyQueries(YOUTUBE_QUERIES, 1)[0];
  console.log('[research] YouTube query:', ytQuery);
  const ytResults = await searchYouTube(ytQuery, 3);
  ytResults.forEach(addIdea);
  console.log(`  ✓ YouTube "${ytQuery}" → ${ytResults.length} resultados`);

  // Actualizar backlog con las ideas nuevas
  const added = backlog.addIdeas(allIdeas);
  const st    = backlog.stats();
  console.log(`\n[research] +${added} ideas nuevas en backlog (${st.pending} pendientes / ${st.published} publicadas)`);

  // Guardar research_latest.json (compatibilidad con versiones anteriores)
  const today  = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const output = {
    generated_at: new Date().toISOString(),
    week:         today,
    total:        allIdeas.length,
    new_in_backlog: added,
    ideas:        allIdeas,
  };

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'research_latest.json'), JSON.stringify(output, null, 2), 'utf8');
  console.log(`[research] ✅ research_latest.json guardado (${allIdeas.length} ideas hoy)`);

  return output;
}

if (require.main === module) {
  research().catch(e => { console.error('[research] Error fatal:', e); process.exit(1); });
}

module.exports = { research };
