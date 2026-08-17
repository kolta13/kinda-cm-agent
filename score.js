// ── Kinda CM Agent — Scoring de ideas del backlog ────────────────────────
// Puntúa TODAS las ideas sin score en batches de 20.
// Llamado desde research.js después de agregar ideas nuevas.
// Output: actualiza score_total, scores, angulo, por_que, audience_type en backlog.json

'use strict';
const https   = require('https');
const config  = require('./config');
const backlog = require('./backlog');
const { withRetry } = require('./retry');

const BATCH_SIZE = 20;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Gemini helper ─────────────────────────────────────────────────────────

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      timeout:  45000,
      headers:  {
        'User-Agent':     'KindaCMAgent/1.0',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
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

async function callGemini(prompt) {
  return withRetry(() => callGeminiOnce(prompt), { label: 'Gemini (score)' });
}

async function callGeminiOnce(prompt) {
  const model = 'gemini-2.5-flash-lite';
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;
  const body  = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.5, maxOutputTokens: 8192 },
  });
  const raw  = await httpPost(url, body);
  const data = JSON.parse(raw);
  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
}

function safeJsonParse(raw) {
  try { return JSON.parse(raw); }
  catch (_) {
    let inString = false, escaped = false, result = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped)                { result += ch; escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; result += ch; continue; }
      if (ch === '"')              { inString = !inString; result += ch; continue; }
      if (inString) {
        if      (ch === '\n') { result += '\\n'; continue; }
        else if (ch === '\r') { result += '\\r'; continue; }
        else if (ch === '\t') { result += '\\t'; continue; }
        else if (ch.charCodeAt(0) < 32) { continue; }
      }
      result += ch;
    }
    return JSON.parse(result);
  }
}

// ── Scoring de un batch ───────────────────────────────────────────────────

async function scoreBatch(ideas) {
  const ideasList = ideas.map((idea, i) =>
    `${i + 1}. "${idea.title}" — ${(idea.description || '').slice(0, 100)}`
  ).join('\n');

  const prompt = `Eres el editor de contenido de Kinda Club (kindaclub.com), plataforma para la industria musical de latinoamérica.

Distribución de audiencia objetivo:
- 80% del contenido: ARTISTAS INDEPENDIENTES (lanzamientos, presupuesto, equipo, procesos, feedback)
- 20% del contenido: PROFESIONALES DE LA MÚSICA (conseguir clientes, portafolio, tarifas)

Tienes estas ${ideas.length} ideas de contenido:

${ideasList}

Para cada idea:
1. Clasifica la audiencia: "artista" o "profesional"
2. Puntúa del 1 al 10 según:
   - Relevancia para esa audiencia en LATAM (1-10)
   - Potencial de engagement (guardar, compartir) (1-10)
   - Ángulo diferenciador — ¿dice algo que la mayoría no dice? (1-10)
   - Aplicabilidad inmediata — ¿se puede aplicar hoy? (1-10)
3. score_total = promedio de los 4 criterios

Responde SOLO con JSON válido:
{
  "scores": [
    {
      "index": 1,
      "title": "título original exacto",
      "audience_type": "artista",
      "score_total": 8.5,
      "scores": {"relevancia": 9, "engagement": 8, "diferenciador": 8, "aplicabilidad": 9},
      "angulo": "El ángulo específico del carrusel en 1 oración",
      "por_que": "Por qué este tema funciona para esta audiencia en 1-2 oraciones"
    }
  ]
}`;

  const raw    = await callGemini(prompt);
  const result = safeJsonParse(raw);
  return result.scores || [];
}

// ── Función principal ─────────────────────────────────────────────────────

async function scoreNewIdeas() {
  const bl       = backlog.load();
  const unscored = bl.ideas.filter(i => i.status === 'pending' && i.score_total === null);

  if (unscored.length === 0) {
    console.log('[score] Todas las ideas pendientes ya tienen score.');
    return 0;
  }

  const batches = Math.ceil(unscored.length / BATCH_SIZE);
  console.log(`[score] ${unscored.length} ideas sin score → ${batches} batch(es) de ${BATCH_SIZE}`);

  let totalScored = 0;

  for (let i = 0; i < unscored.length; i += BATCH_SIZE) {
    const batch     = unscored.slice(i, i + BATCH_SIZE);
    const batchNum  = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`[score] Batch ${batchNum}/${batches} (${batch.length} ideas)...`);

    try {
      const scores = await scoreBatch(batch);
      backlog.updateScores(scores);
      totalScored += scores.length;
      console.log(`  ✓ ${scores.length} ideas puntuadas`);
    } catch (e) {
      console.warn(`  ⚠ Batch ${batchNum} falló: ${e.message}`);
    }

    if (i + BATCH_SIZE < unscored.length) await sleep(1500);
  }

  console.log(`[score] ✅ ${totalScored}/${unscored.length} ideas puntuadas en backlog`);
  return totalScored;
}

if (require.main === module) {
  scoreNewIdeas().catch(e => { console.error('[score] Error fatal:', e); process.exit(1); });
}

module.exports = { scoreNewIdeas };
