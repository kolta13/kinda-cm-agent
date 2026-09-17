// ── Kinda CM Agent — Descubrimiento de casos de artista ──────────────────
// Convierte las herramientas gratis ya construidas (Spotify Web API +
// historial de oyentes vía Wayback Machine) en un SCREENING automático en
// vez de buscar candidatos "a ojo" en Google cada vez.
//
// Sigue siendo detección "manual/orgánica" en el sentido de que la LISTA
// de candidatos a revisar (SEED_ARTISTS) la arma un humano — no hay forma
// gratis de generar esa lista sola (Spotify no tiene un endpoint "dame
// artistas chilenos", y pagar Chartmetric/Soundcharts para eso es
// justamente lo que se decidió no hacer el 2026-09-17). Lo que SÍ se
// automatiza es rankear la lista por crecimiento real, en vez de que un
// humano tenga que googlear "artista chileno creció mucho" y leer
// artículos uno por uno.
//
// Uso: node discover-cases.js 2024
//      node discover-cases.js 2024 CL
//      node discover-cases.js 2024 CL "Nombre extra 1,Nombre extra 2"  (agrega candidatos ad-hoc a la lista base)

'use strict';
const { getSpotifyToken, findSpotifyArtist, getListenerHistory } = require('./artist-research');

// Lista semilla — artistas chilenos urbanos/emergentes reales, juntados de
// la investigación de casos de hoy (2026-09-17): la cuenta @chartscl (top
// oyentes mensuales de Chile), más los que fueron apareciendo como
// colaboradores/menciones de prensa reales en los dossiers ya armados.
// Deliberadamente mezcla ya-consolidados (para tener puntos de comparación)
// con más under/emergentes — el ranking por multiplicador de crecimiento es
// lo que separa "ya explotó hace años" de "está despegando este año".
const SEED_ARTISTS = [
  'Kidd Voodoo', 'Akriila', 'FloyyMenor', 'Jere Klein', 'Kreamly',
  'Cris MJ', 'Young Cister', 'Katteyes', 'Easykid', 'Mateo on the beatz',
  'Luanko', 'Princesa Alba', 'Bryartz', 'Aqua VS', 'Gianluca',
  'El Bugg', 'FaceBrooklyn', 'Kuina', 'Pailita', 'Polimá Westcoast',
];

async function screenArtist(name, year, market, token) {
  try {
    const candidates = await findSpotifyArtist(name, token);
    if (candidates.length === 0) return { name, error: 'Sin coincidencia en Spotify' };
    const best = [...candidates].sort((a, b) => (b.followers || 0) - (a.followers || 0))[0];

    const history = await getListenerHistory(best.id, year);
    if (!history.available) return { name, spotifyName: best.name, error: history.note };

    return {
      name, spotifyName: best.name, spotifyId: best.id,
      from: history.growth.from, to: history.growth.to,
      multiplier: history.growth.multiplier,
    };
  } catch (e) {
    return { name, error: e.message };
  }
}

async function discoverCases(year, market = 'CL', extraNames = []) {
  const token = await getSpotifyToken();
  const names = [...SEED_ARTISTS, ...extraNames];
  const results = [];

  console.log(`[discover-cases] Screening ${names.length} artistas para ${year} (mercado ${market})...\n`);

  for (const name of names) {
    process.stdout.write(`  ${name}... `);
    const r = await screenArtist(name, year, market, token);
    results.push(r);
    console.log(r.error ? `⚠ ${r.error}` : `x${r.multiplier} (${r.from.listeners.toLocaleString('es-CL')} → ${r.to.listeners.toLocaleString('es-CL')})`);
    // Espaciar: cada screenArtist ya hace varias requests a Wayback Machine,
    // que rate-limitea agresivo con demasiadas seguidas (visto en vivo).
    await new Promise(res => setTimeout(res, 500));
  }

  const ranked = results
    .filter(r => !r.error && r.multiplier != null)
    .sort((a, b) => b.multiplier - a.multiplier);

  console.log(`\n[discover-cases] Ranking por crecimiento en ${year} (mercado ${market}):\n`);
  ranked.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.spotifyName} — x${r.multiplier} (${r.from.listeners.toLocaleString('es-CL')} el ${r.from.date} → ${r.to.listeners.toLocaleString('es-CL')} el ${r.to.date})`);
  });

  const sinDatos = results.filter(r => r.error);
  if (sinDatos.length > 0) {
    console.log(`\n  Sin datos suficientes (${sinDatos.length}): ${sinDatos.map(r => r.name).join(', ')}`);
  }

  console.log('\n[discover-cases] Siguiente paso: elige un candidato del ranking y corre');
  console.log(`  node artist-research.js "Nombre" ${year} ${market}`);
  console.log('  para armar el dossier completo (discografía, charts, noticias, foto).');

  return ranked;
}

async function main() {
  const [yearArg, market, extraArg] = process.argv.slice(2);
  if (!yearArg) {
    console.log('Uso: node discover-cases.js 2024 [market] ["Nombre extra 1,Nombre extra 2"]');
    process.exit(0);
  }
  const extraNames = extraArg ? extraArg.split(',').map(s => s.trim()).filter(Boolean) : [];
  await discoverCases(Number(yearArg), market || 'CL', extraNames);
}

if (require.main === module) {
  main().catch(e => { console.error('[discover-cases] Error:', e.message); process.exit(1); });
}

module.exports = { discoverCases };
