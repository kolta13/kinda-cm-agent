// ── Kinda CM Agent — Fase 2: Score + Generación de Copy ─────────────────
// Lee el backlog de ideas, elige la de mayor potencial sin repetir temas
// recientes, y genera el copy completo del carrusel ganador.
// Output: data/carousel_latest.json
//
// Uso: node generate.js

'use strict';
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const config  = require('./config');
const backlog = require('./backlog');

// ── HTTP helper ───────────────────────────────────────────────────────────

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      timeout:  30000,
      headers:  {
        'User-Agent':     'KindaCMAgent/1.0',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
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
  const model = 'gemini-2.5-flash-lite';
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 8192 },
  });

  const raw  = await httpPost(url, body);
  const data = JSON.parse(raw);
  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
}

// ── Fase 2a: Scoring ──────────────────────────────────────────────────────

async function scoreIdeas(ideas) {
  console.log(`[generate] Puntuando ${ideas.length} ideas con Gemini...`);

  const ideasList = ideas.map((idea, i) =>
    `${i + 1}. "${idea.title}" — ${idea.description.slice(0, 120)}`
  ).join('\n');

  const prompt = `Eres el community manager de Kinda Club (kindaclub.com), una plataforma tipo LinkedIn para la industria musical de latinoamérica. Tu audiencia son músicos independientes que quieren crecer profesionalmente.

Tienes estas ${ideas.length} ideas de contenido basadas en tendencias reales de búsqueda y redes sociales:

${ideasList}

Puntúa cada idea del 1 al 10 según estos criterios para un CARRUSEL de Instagram/TikTok:
- Relevancia para músicos independientes latam (1-10)
- Potencial de engagement (guardar, compartir, comentar) (1-10)
- Ángulo diferenciador (¿dice algo que la mayoría no dice?) (1-10)
- Aplicabilidad inmediata (¿el músico puede aplicarlo hoy?) (1-10)

Responde SOLO con JSON válido, sin texto adicional:
{
  "scores": [
    {
      "index": 1,
      "title": "título original",
      "score_total": 8.5,
      "scores": {"relevancia": 9, "engagement": 8, "diferenciador": 8, "aplicabilidad": 9},
      "angulo": "El ángulo específico del carrusel en 1 oración",
      "por_que": "Por qué este tema funciona para esta audiencia en 1-2 oraciones"
    }
  ]
}`;

  const raw    = await callGemini(prompt);
  const result = JSON.parse(raw);
  return result.scores;
}

// ── Fase 2b: Generación de copy ───────────────────────────────────────────

async function generateCarousel(winner) {
  console.log(`[generate] Generando carrusel para: "${winner.title}"`);

  const prompt = `Eres el community manager de Kinda Club (kindaclub.com), plataforma para músicos independientes de latinoamérica. Tu estilo es directo, práctico y cercano — como un colega de la industria que comparte lo que realmente funciona. Sin jerga académica, sin frases motivacionales vacías.

El tema del carrusel es: "${winner.title}"
Ángulo: ${winner.angulo}
Por qué funciona: ${winner.por_que}

Genera el copy completo para un carrusel de Instagram/TikTok de 7 slides. El formato es educativo/informativo, estilo "lista de tips" o "guía práctica".

Reglas:
- Slide 1 (portada): titular de MÁXIMO 7 palabras, que detenga el scroll. Muy directo.
- Slides 2-6: cada uno con un punto concreto. Título corto (máx 5 palabras) + body de 2-3 líneas explicando el punto con especificidad (números, ejemplos reales, datos si los tienes).
- Slide 7 (CTA): invitar a conectar con otros músicos en Kinda Club. Frase natural, no corporativa.
- Todo en español latino neutro. Sin chilenismos, sin voseo argentino (usar "tú/tienes/conecta", nunca "vos/tenés/conectás").
- Sin signos de exclamación (¡ !) en ningún slide. Cero. El tono es directo y seguro, no exclamativo.
- El tono es: colega de industria, no profesor ni coach.

Responde SOLO con JSON válido:
{
  "tema": "tema del carrusel",
  "angulo": "ángulo elegido",
  "slides": [
    {
      "numero": 1,
      "tipo": "portada",
      "titulo": "El titular que detiene el scroll",
      "subtitulo": "Subtítulo opcional de apoyo (max 10 palabras) o null",
      "body": null
    },
    {
      "numero": 2,
      "tipo": "contenido",
      "titulo": "Punto 1 en 5 palabras",
      "subtitulo": null,
      "body": "Explicación específica de 2-3 líneas con datos o ejemplos concretos."
    },
    {
      "numero": 3,
      "tipo": "contenido",
      "titulo": "Punto 2 en 5 palabras",
      "subtitulo": null,
      "body": "Explicación específica de 2-3 líneas."
    },
    {
      "numero": 4,
      "tipo": "contenido",
      "titulo": "Punto 3 en 5 palabras",
      "subtitulo": null,
      "body": "Explicación específica de 2-3 líneas."
    },
    {
      "numero": 5,
      "tipo": "contenido",
      "titulo": "Punto 4 en 5 palabras",
      "subtitulo": null,
      "body": "Explicación específica de 2-3 líneas."
    },
    {
      "numero": 6,
      "tipo": "contenido",
      "titulo": "Punto 5 en 5 palabras",
      "subtitulo": null,
      "body": "Explicación específica de 2-3 líneas."
    },
    {
      "numero": 7,
      "tipo": "cta",
      "titulo": "¿Eres músico independiente?",
      "subtitulo": null,
      "body": "Kinda Club es la red donde conectas con otros artistas, managers y productores de LATAM. Únete gratis en kindaclub.com"
    }
  ],
  "caption_instagram": "Caption para Instagram. Tono directo y humano — como si lo escribiera un músico que sabe del tema, no un community manager corporativo. Sin signos de exclamación. Sin 'Atención X', sin frases motivacionales vacías, sin exageración. Máximo 3 líneas de texto + 1 línea en blanco + exactamente 4 hashtags: 1 amplio con alto volumen LATAM (ej: #Musicos, #MusicaLatina), 2 de nicho relacionados con el tema exacto del carrusel que usa la comunidad de músicos independientes, 1 de marca (#KindaClub). Emojis opcionales y sobrios.",
  "hashtags": ["#musica", "#artista", "..."]
}`;

  const raw      = await callGemini(prompt);
  const carousel = JSON.parse(raw);
  return neutralizeSpanish(carousel);
}

// ── Post-procesamiento ────────────────────────────────────────────────────

function neutralizeText(text) {
  if (typeof text !== 'string') return text;

  const fixes = [
    [/\bconectás\b/g,  'conectas'],
    [/\btenés\b/g,     'tienes'],
    [/\bpodés\b/g,     'puedes'],
    [/\bhacés\b/g,     'haces'],
    [/\busás\b/g,      'usas'],
    [/\bsabés\b/g,     'sabes'],
    [/\bquerés\b/g,    'quieres'],
    [/\bganás\b/g,     'ganas'],
    [/\bsubís\b/g,     'subes'],
    [/\bvendés\b/g,    'vendes'],
    [/\bcreás\b/g,     'creas'],
    [/\bcompartís\b/g, 'compartes'],
    [/\bgenerás\b/g,   'generas'],
    [/\baprendés\b/g,  'aprendes'],
    [/\bconocés\b/g,   'conoces'],
    [/\bempezás\b/g,   'empiezas'],
    [/\bquedás\b/g,    'quedas'],
    [/\bsos\b/g,       'eres'],
    [/\bVos\b/g,       'Tú'],
    [/\bvos\b/g,       'tú'],
    [/\bChe\b/g,       ''],
    [/\bche\b/g,       ''],
    [/\bla guita\b/gi, 'el dinero'],
    [/\bguita\b/gi,    'dinero'],
    [/\blaburo\b/gi,   'trabajo'],
    [/\bpibe\b/gi,     'músico'],
    [/\bcopado\b/gi,   'genial'],
  ];

  let result = text;
  for (const [pattern, replacement] of fixes) result = result.replace(pattern, replacement);
  // Eliminar signos de exclamación
  result = result.replace(/¡/g, '').replace(/!/g, '.').replace(/\.{2,}/g, '.');
  return result;
}

function neutralizeSpanish(obj) {
  if (typeof obj === 'string') return neutralizeText(obj);
  if (Array.isArray(obj))      return obj.map(neutralizeSpanish);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const key of Object.keys(obj)) out[key] = neutralizeSpanish(obj[key]);
    return out;
  }
  return obj;
}

// ── Función principal ─────────────────────────────────────────────────────

async function generate() {
  // Obtener topics publicados recientemente (últimos 5 días → no repetir)
  const recentTopics = backlog.getRecentTopics(5);
  console.log('[generate] Topics recientes (excluidos):', [...recentTopics].join(', ') || 'ninguno');

  // Obtener ideas pendientes del backlog
  let pending = backlog.getPendingIdeas(recentTopics);

  if (pending.length === 0) {
    // Si el backlog está vacío, intentar leer research_latest como fallback
    const researchPath = path.join(__dirname, 'data', 'research_latest.json');
    if (fs.existsSync(researchPath)) {
      console.log('[generate] Backlog vacío — usando research_latest.json como fallback');
      const research = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
      backlog.addIdeas(research.ideas || []);
      pending = backlog.getPendingIdeas(recentTopics);
    }
    if (pending.length === 0) {
      console.error('[generate] Sin ideas pendientes. Corre research.js primero.');
      process.exit(1);
    }
  }

  console.log(`[generate] ${pending.length} ideas pendientes en backlog`);

  // Limitar a 20 para no gastar demasiado en scoring
  const toScore = pending.slice(0, 20);

  // Puntuar con Gemini
  const scores = await scoreIdeas(toScore);
  const sorted = scores
    .filter(s => s && s.score_total)
    .sort((a, b) => b.score_total - a.score_total);

  // Actualizar scores en el backlog
  backlog.updateScores(sorted);

  console.log('\n[generate] Top 5 ideas:');
  sorted.slice(0, 5).forEach((s, i) => {
    console.log(`  ${i + 1}. [${s.score_total}] ${s.title}`);
  });

  const winner = sorted[0];
  const winnerId = backlog.ideaId(winner.title);
  console.log(`\n[generate] Ganador: "${winner.title}" (score: ${winner.score_total}, topic: ${pending.find(p => backlog.ideaId(p.title) === winnerId)?.topic_tag || '?'})`);

  // Generar copy del carrusel
  const carousel = await generateCarousel(winner);

  const today  = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const output = {
    generated_at: new Date().toISOString(),
    week:         today,
    winner_score: winner.score_total,
    backlog_id:   winnerId,
    all_scores:   sorted,
    carousel,
  };

  const dataDir = path.join(__dirname, 'data');
  const outPath = path.join(dataDir, 'carousel_latest.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log('\n[generate] Carrusel generado:');
  console.log('  Tema:', carousel.tema);
  carousel.slides.forEach(s => console.log(`    Slide ${s.numero} [${s.tipo}]: ${s.titulo}`));
  console.log('\n  Caption preview:', carousel.caption_instagram?.slice(0, 120) + '...');
  console.log(`\n[generate] ✅ Guardado en ${outPath}`);

  return output;
}

if (require.main === module) {
  generate().catch(e => { console.error('[generate] Error fatal:', e); process.exit(1); });
}

module.exports = { generate };
