// ── Kinda CM Agent — Agregar ideas manualmente al backlog ───────────────
// Permite agregar ideas o lineamientos de contenido al backlog
// sin necesidad de correr el research completo.
//
// Uso 1 — desde un archivo JSON:
//   node add-to-backlog.js ideas.json
//
// Uso 2 — idea rápida desde la línea de comandos:
//   node add-to-backlog.js "Cómo conseguir tu primera colaboración"
//   node add-to-backlog.js "Cómo hacer merch sin inventario" "Print-on-demand, plataformas como Printful"
//
// Formato del archivo JSON:
//   [
//     { "title": "Título de la idea", "description": "Descripción opcional" },
//     { "title": "Otra idea", "topic_tag": "monetizacion" }
//   ]
//
// topic_tag válidos: monetizacion, distribucion, marketing, video_viral,
//                   shows, networking, tecnologia, noticias, general

'use strict';
const fs      = require('fs');
const path    = require('path');
const backlog = require('./backlog');

async function main() {
  const [,, ...args] = process.argv;

  if (args.length === 0) {
    console.log('Uso:');
    console.log('  node add-to-backlog.js ideas.json');
    console.log('  node add-to-backlog.js "Título de la idea"');
    console.log('  node add-to-backlog.js "Título" "Descripción opcional"');
    process.exit(0);
  }

  let ideas = [];

  const firstArg = args[0];

  // Si el argumento es un archivo JSON existente
  if (firstArg.endsWith('.json') && fs.existsSync(firstArg)) {
    const raw = fs.readFileSync(firstArg, 'utf8');
    ideas = JSON.parse(raw);
    if (!Array.isArray(ideas)) ideas = [ideas];
    console.log(`[add-to-backlog] Leyendo ${ideas.length} ideas desde ${firstArg}...`);
  } else {
    // Argumento directo: título (+ descripción opcional)
    ideas = [{
      title:       firstArg,
      description: args[1] || '',
      source:      'manual',
    }];
  }

  // Añadir fuente 'manual' si no viene especificada
  ideas = ideas.map(idea => ({
    ...idea,
    source: idea.source || 'manual',
  }));

  const added = backlog.addIdeas(ideas);
  const st    = backlog.stats();

  console.log(`\n✅ ${added} idea(s) nueva(s) agregada(s) al backlog`);
  if (ideas.length - added > 0) console.log(`   ${ideas.length - added} ya existían (duplicadas por título)`);
  console.log(`\nEstado del backlog:`);
  console.log(`  Total:      ${st.total}`);
  console.log(`  Pendientes: ${st.pending}`);
  console.log(`  Publicadas: ${st.published}`);

  // Mostrar las ideas que se agregaron
  if (added > 0) {
    console.log('\nIdeas agregadas:');
    const bl = backlog.load();
    const recent = bl.ideas
      .filter(i => i.source === 'manual' && i.status === 'pending')
      .slice(-added);
    recent.forEach(i => {
      console.log(`  [${i.topic_tag}] ${i.title}`);
    });
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
