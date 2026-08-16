// ── Kinda CM Agent — Orquestador (Fase 5) ───────────────────────────────
// Encadena todas las fases en secuencia:
//   research → generate → render → publish
//
// Incluye file lock para evitar ejecuciones simultáneas y log persistente.
//
// Uso manual:     node agent.js
// Task Scheduler: node "C:\Proyectos Claude Code\cm-agent\agent.js"

'use strict';
const fs   = require('fs');
const path = require('path');

const { research }     = require('./research');
const { generate }     = require('./generate');
const { render }       = require('./render');
const { publish }      = require('./publish');
const { publishTikTok } = require('./publish-tiktok');
const backlog          = require('./backlog');
const config           = require('./config');

const DATA_DIR  = path.join(__dirname, 'data');
const LOCK_FILE = path.join(DATA_DIR, 'agent.lock');
const LOG_FILE  = path.join(DATA_DIR, 'agent.log');

// ── Logger ────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}

// ── File lock ─────────────────────────────────────────────────────────────

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const lockedAt = parseInt(content, 10);
    const ageMs = Date.now() - lockedAt;

    // Lock viejo de más de 2 horas → asumir proceso muerto, limpiar
    if (ageMs > 2 * 60 * 60 * 1000) {
      log(`[agent] Lock stale (${Math.round(ageMs / 60000)} min). Limpiando.`);
      fs.unlinkSync(LOCK_FILE);
    } else {
      log(`[agent] Ya hay una ejecución en curso (lock ${Math.round(ageMs / 60000)} min). Abortando.`);
      process.exit(0);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(Date.now()), 'utf8');
}

function releaseLock() {
  if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
}

// ── Orquestador ───────────────────────────────────────────────────────────

async function run() {
  // Asegurar que existe el directorio de datos
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  acquireLock();
  const startTime = Date.now();

  try {
    log('[agent] ════════════════════════════════════════');
    log('[agent] Kinda CM Agent — inicio de ciclo');
    const st = backlog.stats();
    log(`[agent] Backlog: ${st.pending} ideas pendientes / ${st.published} publicadas`);
    log('[agent] ════════════════════════════════════════');

    // ── Fase 1: Research ────────────────────────────────────────────────
    log('[agent] Fase 1: Research...');
    const researchResult = await research();
    log(`[agent] ✓ Research: ${researchResult.ideas.length} ideas encontradas (semana ${researchResult.week})`);

    // ── Fase 2: Generate ────────────────────────────────────────────────
    log('[agent] Fase 2: Generate...');
    const generateResult = await generate();
    log(`[agent] ✓ Generate: "${generateResult.carousel.tema}" (score ${generateResult.winner_score})`);

    // ── Fase 3: Render ──────────────────────────────────────────────────
    log('[agent] Fase 3: Render...');
    const renderResult = await render();
    log(`[agent] ✓ Render: ${renderResult.slides.length} slides generados`);

    // ── Fase 4: Publish (Instagram) ─────────────────────────────────────
    log('[agent] Fase 4: Publish (Instagram)...');
    const publishResult = await publish();
    log(`[agent] ✓ Publish Instagram: Post ID ${publishResult.post_id}`);

    // ── Fase 4b: Publish (TikTok) — soft-fail ───────────────────────────
    let tiktokPostId = null;
    if (config.tiktokRefreshToken) {
      log('[agent] Fase 4b: Publish (TikTok)...');
      try {
        const tiktokResult = await publishTikTok();
        if (tiktokResult) {
          tiktokPostId = tiktokResult.post_id;
          log(`[agent] ✓ Publish TikTok: Post ID ${tiktokPostId}`);
        }
      } catch (tiktokErr) {
        log(`[agent] ⚠ TikTok falló (Instagram ya publicado): ${tiktokErr.message}`);
      }
    } else {
      log('[agent] Fase 4b: TikTok no configurado — saltando');
    }

    // ── Resumen ──────────────────────────────────────────────────────────
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log('[agent] ════════════════════════════════════════');
    log(`[agent] ✅ Ciclo completo en ${elapsed}s`);
    log(`[agent]    Tema:         ${generateResult.carousel.tema}`);
    log(`[agent]    Instagram ID: ${publishResult.post_id}`);
    if (tiktokPostId) log(`[agent]    TikTok ID:    ${tiktokPostId}`);
    log('[agent] ════════════════════════════════════════');

    // Guardar resumen del último ciclo
    fs.writeFileSync(
      path.join(DATA_DIR, 'agent_latest.json'),
      JSON.stringify({
        completed_at:   new Date().toISOString(),
        elapsed_sec:    elapsed,
        week:           publishResult.week,
        tema:           generateResult.carousel.tema,
        winner_score:   generateResult.winner_score,
        slides:         renderResult.slides.length,
        post_id:        publishResult.post_id,
        tiktok_post_id: tiktokPostId || null,
      }, null, 2),
      'utf8'
    );

  } catch (err) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`[agent] ❌ Error en ciclo (${elapsed}s): ${err.message}`);
    log(`[agent]    Stack: ${err.stack?.split('\n')[1]?.trim() || '—'}`);
    releaseLock();
    process.exit(1);
  }

  releaseLock();
}

// ── Ejecución directa ─────────────────────────────────────────────────────
if (require.main === module) {
  run().catch(e => {
    console.error('[agent] Error fatal:', e.message);
    releaseLock();
    process.exit(1);
  });
}

module.exports = { run };
