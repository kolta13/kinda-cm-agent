// ── Kinda CM Agent — Descubrimiento de casos de artista ──────────────────
// Ranking ACUMULATIVO de artistas por crecimiento real de oyentes mensuales
// en Spotify (historial vía Wayback Machine, ver getListenerHistory en
// artist-research.js). Cada corrida suma candidatos nuevos y guarda todo en
// data/discovery_ranking.json — nada se vuelve a consultar dos veces.
//
// De dónde salen los candidatos (todo gratis):
//   1. SEED_ARTISTS: lista base armada por un humano.
//   2. --snowball: colaboradores del año de los artistas semilla y de los que
//      ya crecieron en el ranking (la escena se conecta por colaboraciones —
//      así aparecen artistas chicos que nunca saldrían en una búsqueda de
//      prensa). Se filtran por seguidores (evita gigantes y páginas vacías)
//      y por género de Spotify (descarta los que claramente no son chilenos;
//      los que no tienen género quedan marcados "género desconocido" para
//      que un humano juzgue).
//   3. --add "Nombre 1,Nombre 2": candidatos puntuales.
//
// Limitaciones reales (no bugs):
//   - No existe endpoint gratis de "dame artistas chilenos" — por eso el
//     snowball, en vez de pagar Chartmetric/Soundcharts (descartado 2026-09-17).
//   - Wayback Machine no tiene capturas útiles de todas las páginas de
//     Spotify: ~40% de los artistas quedan "sin datos" (se guardan igual para
//     no reintentarlos, salvo con --retry-errors).
//   - La ventana entre la primera y la última captura NO siempre calza con el
//     año calendario. Por eso cada entrada guarda los días de ventana y se
//     marca cuando es corta (<300 días: el crecimiento real del año podría
//     ser mayor) o larga (>430: puede incluir crecimiento de otro año).
//
// Uso:
//   node discover-cases.js 2024 --snowball --limit 25
//   node discover-cases.js 2024 --show --min 10        (solo mostrar, sin consultar)
//   node discover-cases.js 2024 --add "Kuina,Otro Artista" --limit 5
//   Opciones: --market CL  --retry-errors  --max-followers N  --min-followers N
//   Para cazar crecimientos grandes (x10+), conviene --max-followers 400000: los
//   artistas ya grandes casi nunca multiplican x10, y los chicos sí.

'use strict';
const fs   = require('fs');
const path = require('path');
const {
  getSpotifyToken, findSpotifyArtist, getListenerHistory, getArtistReleasesForYear,
} = require('./artist-research');

const RANKING_PATH = path.join(__dirname, 'data', 'discovery_ranking.json');

// Lista base — artistas chilenos urbanos/emergentes reales juntados de la
// investigación del 2026-09-17 (@chartscl + colaboradores de los dossiers).
const SEED_ARTISTS = [
  'Kidd Voodoo', 'Akriila', 'FloyyMenor', 'Jere Klein', 'Kreamly',
  'Cris MJ', 'Young Cister', 'Katteyes', 'Easykid', 'Mateo on the beatz',
  'Luanko', 'Princesa Alba', 'Bryartz', 'Aqua VS', 'Gianluca',
  'El Bugg', 'FaceBrooklyn', 'Kuina', 'Pailita', 'Polimá Westcoast',
];

const OTRO_PAIS_RE = /argentin|mexic|corrido|norte[ñn]o|puerto ?rican|colombi|españ|spanish|dominic|venezuel|peruvian|per[uú]|cuban|k-?pop|brazil|brasil|italian|french|german|nigerian|afro/i;

// Rango de seguidores actuales para candidatos del snowball: descarta
// gigantes ya consolidados y páginas casi vacías (sin capturas útiles).
let MIN_FOLLOWERS = 3000;
let MAX_FOLLOWERS = 3000000;

// ── Persistencia ─────────────────────────────────────────────────────────

function loadRanking() {
  let r;
  try { r = JSON.parse(fs.readFileSync(RANKING_PATH, 'utf8')); }
  catch (_) { return { updated_at: null, entries: {} }; }
  // Entradas guardadas antes de distinguir fallas temporales: un timeout o un
  // "pocas capturas" pudo ser un error de red disfrazado, así que se reintentan.
  // "Sin capturas de Internet Archive" (la lista CDX vino vacía) sí es definitivo.
  Object.values(r.entries).forEach(e => {
    if (e.status === 'sin_datos' && /no respondió|suficientes capturas/i.test(e.note || '')) e.status = 'reintentar';
  });
  return r;
}

function saveRanking(r) {
  r.updated_at = new Date().toISOString();
  fs.writeFileSync(RANKING_PATH, JSON.stringify(r, null, 2), 'utf8');
}

const keyOf = (spotifyId, year) => `${spotifyId}_${year}`;
const sleep = ms => new Promise(res => setTimeout(res, ms));
const fmt = n => n.toLocaleString('es-CL');

function daysBetween(d1, d2) {
  return Math.round((new Date(d2) - new Date(d1)) / 86400000);
}

// ── Screening de un artista ──────────────────────────────────────────────

async function screenArtist(candidate, year) {
  const base = {
    name: candidate.name, spotifyName: candidate.spotifyName || candidate.name, spotifyId: candidate.id,
    year, followers: candidate.followers ?? null, genres: candidate.genres || [],
    screened_at: new Date().toISOString(),
  };
  try {
    const history = await getListenerHistory(candidate.id, year);
    if (!history.available) return { ...base, status: history.temporal ? 'reintentar' : 'sin_datos', note: history.note };
    const g = history.growth;
    const days = daysBetween(g.from.date, g.to.date);
    return {
      ...base, status: 'ok', from: g.from, to: g.to, days,
      multiplier: g.multiplier, puntos: history.points.length,
      ventana: days < 300 ? 'corta' : days > 430 ? 'larga' : 'anual',
    };
  } catch (e) {
    return { ...base, status: 'reintentar', note: e.message };
  }
}

// ── Snowball: colaboradores de artistas de la escena ─────────────────────

async function collectSnowballNames(year, market, token, ranking) {
  const seedNames = new Set(SEED_ARTISTS);
  // Suma los que ya demostraron crecer (x3+) — sus colaboradores son
  // los más probables de estar en la misma ola.
  Object.values(ranking.entries)
    .filter(e => e.year === year && e.status === 'ok' && e.multiplier >= 3)
    .forEach(e => seedNames.add(e.spotifyName));

  const collab = new Set();
  console.log(`[discover-cases] Snowball: leyendo colaboradores ${year} de ${seedNames.size} artistas semilla...`);
  for (const seed of seedNames) {
    try {
      const cands = await findSpotifyArtist(seed, token);
      if (cands.length === 0) continue;
      const best = [...cands].sort((a, b) => (b.followers || 0) - (a.followers || 0))[0];
      const rel = await getArtistReleasesForYear(best.id, year, token, market);
      rel.distinctCollaboratorNames.forEach(n => collab.add(n));
    } catch (_) { /* un semilla que falla no frena el resto */ }
  }
  collab.delete('Various Artists');
  return [...collab];
}

// Resuelve nombres → candidatos de Spotify, filtrando por seguidores y género.
async function resolveCandidates(names, token, ranking, year, retryErrors) {
  const out = [];
  const vistos = new Set();
  for (const name of names) {
    try {
      const cands = await findSpotifyArtist(name, token);
      if (cands.length === 0) continue;
      const best = [...cands].sort((a, b) => (b.followers || 0) - (a.followers || 0))[0];
      if (vistos.has(best.id)) continue; // dos nombres distintos pueden resolver al mismo artista
      vistos.add(best.id);
      const prev = ranking.entries[keyOf(best.id, year)];
      if (prev && prev.status !== 'reintentar' && !(retryErrors && prev.status === 'sin_datos')) continue; // ya consultado
      if (best.followers != null && (best.followers < MIN_FOLLOWERS || best.followers > MAX_FOLLOWERS)) continue;
      const generosConocidos = best.genres.length > 0;
      // Solo se descarta si el género apunta claramente a OTRO país. Exigir la
      // palabra "chile" dejaba afuera a chilenos reales (Akriila es "neoperreo").
      if (generosConocidos && best.genres.some(g => OTRO_PAIS_RE.test(g))) continue;
      out.push({ ...best, spotifyName: best.name, name, generoDesconocido: !generosConocidos });
    } catch (_) { /* nombre que falla se salta */ }
  }
  // Más seguidores primero: mayor probabilidad de tener capturas en Wayback.
  return out.sort((a, b) => (b.followers || 0) - (a.followers || 0));
}

// ── Presentación ─────────────────────────────────────────────────────────

function showRanking(ranking, year, minMultiplier) {
  const rows = Object.values(ranking.entries)
    .filter(e => e.year === year && e.status === 'ok' && e.multiplier >= minMultiplier)
    .sort((a, b) => b.multiplier - a.multiplier);
  const total = Object.values(ranking.entries).filter(e => e.year === year).length;
  const sinDatos = Object.values(ranking.entries).filter(e => e.year === year && e.status === 'sin_datos').length;

  console.log(`\n[discover-cases] Ranking ${year}${minMultiplier > 1 ? ` (solo x${minMultiplier} o más)` : ''} — ${total} artistas revisados, ${sinDatos} sin datos en Wayback:\n`);
  if (rows.length === 0) console.log('  (ninguno todavía)');
  rows.forEach((e, i) => {
    const flags = [];
    if (e.ventana === 'corta') flags.push(`⚠ ventana corta ${e.days}d`);
    if (e.ventana === 'larga') flags.push(`⚠ ventana larga ${e.days}d`);
    if (e.generoDesconocido) flags.push('género desconocido');
    console.log(`  ${String(i + 1).padStart(2)}. ${e.spotifyName} — x${e.multiplier} (${fmt(e.from.listeners)} el ${e.from.date} → ${fmt(e.to.listeners)} el ${e.to.date})${flags.length ? '  [' + flags.join(', ') + ']' : ''}`);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { year: null, market: 'CL', limit: 25, min: 1, snowball: false, show: false, retryErrors: false, add: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--snowball') args.snowball = true;
    else if (a === '--show') args.show = true;
    else if (a === '--retry-errors') args.retryErrors = true;
    else if (a === '--market') args.market = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--min') args.min = Number(argv[++i]);
    else if (a === '--max-followers') MAX_FOLLOWERS = Number(argv[++i]);
    else if (a === '--min-followers') MIN_FOLLOWERS = Number(argv[++i]);
    else if (a === '--add') args.add = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else rest.push(a);
  }
  args.year = Number(rest[0]);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.year) {
    console.log('Uso: node discover-cases.js 2024 [--snowball] [--limit 25] [--min 10] [--show] [--add "A,B"] [--market CL] [--retry-errors]');
    process.exit(0);
  }

  const ranking = loadRanking();
  if (args.show) { showRanking(ranking, args.year, args.min); return; }

  const token = await getSpotifyToken();
  let names = [...SEED_ARTISTS, ...args.add];
  if (args.snowball) names = names.concat(await collectSnowballNames(args.year, args.market, token, ranking));
  names = [...new Set(names)];

  console.log(`[discover-cases] Resolviendo ${names.length} nombres en Spotify (filtro: ${fmt(MIN_FOLLOWERS)}–${fmt(MAX_FOLLOWERS)} seguidores, género chileno o desconocido)...`);
  const queue = await resolveCandidates(names, token, ranking, args.year, args.retryErrors);
  const batch = queue.slice(0, args.limit);
  console.log(`[discover-cases] ${queue.length} candidatos nuevos por revisar; este lote: ${batch.length}\n`);

  for (const cand of batch) {
    process.stdout.write(`  ${cand.spotifyName} (${fmt(cand.followers || 0)} seg.)... `);
    const entry = await screenArtist(cand, args.year);
    if (cand.generoDesconocido) entry.generoDesconocido = true;
    ranking.entries[keyOf(cand.id, args.year)] = entry;
    saveRanking(ranking); // guarda tras cada artista: si se corta, no se pierde nada
    console.log(entry.status === 'ok' ? `x${entry.multiplier} (${fmt(entry.from.listeners)} → ${fmt(entry.to.listeners)})` : `⚠ ${entry.note}`);
    await sleep(1500);
  }

  showRanking(ranking, args.year, args.min);
  console.log('\n[discover-cases] Para armar un caso: node artist-research.js "Nombre" ' + args.year + ' ' + args.market);
}

if (require.main === module) {
  main().catch(e => { console.error('[discover-cases] Error:', e.message); process.exit(1); });
}

module.exports = { loadRanking };
