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

// Parsea JSON de Gemini tolerando caracteres de control sin escapar dentro de strings
function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    // Escapar caracteres de control que estén dentro de strings JSON
    let inString = false, escaped = false, result = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped)           { result += ch; escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; result += ch; continue; }
      if (ch === '"')        { inString = !inString; result += ch; continue; }
      if (inString) {
        if      (ch === '\n') { result += '\\n'; continue; }
        else if (ch === '\r') { result += '\\r'; continue; }
        else if (ch === '\t') { result += '\\t'; continue; }
        else if (ch.charCodeAt(0) < 32) { continue; } // descartar resto de control chars
      }
      result += ch;
    }
    return JSON.parse(result);
  }
}

// ── Fase 2a: Scoring ──────────────────────────────────────────────────────

async function scoreIdeas(ideas) {
  console.log(`[generate] Puntuando ${ideas.length} ideas con Gemini...`);

  const ideasList = ideas.map((idea, i) =>
    `${i + 1}. "${idea.title}" — ${idea.description.slice(0, 120)}`
  ).join('\n');

  const prompt = `Eres el editor de contenido de Kinda Club (kindaclub.com), plataforma para la industria musical de latinoamérica.

Distribución de audiencia objetivo:
- 80% del contenido: ARTISTAS INDEPENDIENTES (lanzamientos, presupuesto, equipo, procesos, feedback)
- 20% del contenido: PROFESIONALES DE LA MÚSICA (conseguir clientes, portafolio, tarifas)

Tienes estas ${ideas.length} ideas de contenido basadas en tendencias reales:

${ideasList}

Para cada idea:
1. Clasifica la audiencia: "artista" o "profesional"
2. Puntúa del 1 al 10 según:
   - Relevancia para esa audiencia en LATAM (1-10)
   - Potencial de engagement (guardar, compartir) (1-10)
   - Ángulo diferenciador — ¿dice algo que la mayoría no dice? (1-10)
   - Aplicabilidad inmediata — ¿se puede aplicar hoy? (1-10)

Responde SOLO con JSON válido:
{
  "scores": [
    {
      "index": 1,
      "title": "título original",
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
  return result.scores;
}

// ── Fase 2b: Generación de copy ───────────────────────────────────────────

async function generateCarousel(winner) {
  console.log(`[generate] Generando carrusel para: "${winner.title}"`);

  const prompt = `Eres el creador de contenido de Kinda Club (kindaclub.com). Tu tono es técnico, minimalista, directo y de colega a colega. Hablas como un productor o creativo independiente experimentado, nunca como una agencia de marketing.

El tema del carrusel es: "${winner.title}"
Ángulo: ${winner.angulo}
Por qué funciona: ${winner.por_que}
Audiencia: ${winner.audience_type === 'profesional' ? 'PROFESIONALES DE LA MÚSICA (productores, mezcladores, managers — cómo conseguir clientes, mostrar portafolio, definir tarifas)' : 'ARTISTAS INDEPENDIENTES (lanzamientos, presupuesto, encontrar equipo, procesos, feedback)'}

═══ REGLAS EDITORIALES (OBLIGATORIAS) ═══

CANTIDAD DE SLIDES: Entre 3 y 8 slides en total (portada + contenido + cta). Sin relleno. Solo los slides que el tema justifica.

PORTADA (slide 1) — EL GANCHO:
- Objetivo único: DETENER el scroll Y crear un GAP DE CURIOSIDAD que solo se cierra swipeando.
- Máximo 6 palabras. DURO. Sin excepción.
- La portada NO explica el tema — lo insinúa. El lector necesita swipear para entender.
- FORMATOS que funcionan:
  · Provocación: "Spotify no paga lo que crees."
  · Contradicción: "El 90% lo hace al revés."
  · Consecuencia sin causa: "Tu demo llegó y nadie la escuchó."
  · Número + tensión: "3 errores que cuestan tu placement."
  · Verdad incómoda: "Publicar sin estrategia es regalar música."
- PROHIBIDO: títulos descriptivos ("Estrategia de lanzamiento musical"), subtítulos explicativos, gerundios, cualquier frase que RESUMA o DESCRIBA el contenido del carrusel. Si la portada ya responde la pregunta, nadie swipea.

SLIDES DE CONTENIDO:
- 2 niveles de lectura obligatorios:
  1. "titulo": 3 a 6 palabras. Ancla la atención.
  2. "body": 12 a 18 palabras exactas. Instrucción técnica directa, dato concreto o paso accionable. Nada más.
- Límite total por slide: 25 palabras entre titulo + body.
- Formato preferido: checklist, paso a paso, comparativa Antes/Después.
- PROHIBIDO: explicaciones teóricas densas, frases de relleno.

SLIDE FINAL / CTA:
- Llamado ultradirecto, transaccional, sin rodeos.
- Máximo 10-12 palabras en titulo.
- Si es para ARTISTAS: dirigir a subir proyecto, buscar equipo en el catálogo o postular canción a playlists de Spotify en kindaclub.com.
- Si es para PROFESIONALES: dirigir a crear perfil, subir portafolio y definir tarifas en kindaclub.com.
- body del CTA: null (solo el titulo basta).

LISTA NEGRA — NUNCA USAR:
- Palabras: "Descubre", "Potencia", "Revoluciona", "El secreto para", "En el dinámico mundo de la música".
- Signos de exclamación (¡ !). Cero.
- Voseo argentino: "vos/tenés/conectás/hacés". Usar siempre "tú/tienes/conecta/haces".
- Chilenismos ni jerga regional.

CAPTION DE INSTAGRAM:
- Tono: músico experimentado hablando con un colega. Sin hype.
- Máximo 3 líneas + línea en blanco + exactamente 4 hashtags.
- Hashtags: 1 amplio LATAM (#Musicos o #MusicaLatina) + 2 de nicho del tema + #KindaClub.
- Sin exclamaciones. Emojis: máximo 2, solo si suman.

Responde SOLO con JSON válido:
{
  "tema": "tema del carrusel",
  "angulo": "ángulo elegido",
  "audience_type": "artista",
  "slides": [
    {
      "numero": 1,
      "tipo": "portada",
      "titulo": "Declaración contundente, max 10 palabras",
      "subtitulo": null,
      "body": null
    },
    {
      "numero": 2,
      "tipo": "contenido",
      "titulo": "3-6 palabras que anclan",
      "subtitulo": null,
      "body": "12 a 18 palabras de instrucción técnica directa o dato concreto accionable."
    },
    {
      "numero": 3,
      "tipo": "contenido",
      "titulo": "Otro punto clave",
      "subtitulo": null,
      "body": "12 a 18 palabras exactas. Sin relleno."
    },
    {
      "numero": 4,
      "tipo": "cta",
      "titulo": "CTA ultradirecto max 12 palabras hacia kindaclub.com",
      "subtitulo": null,
      "body": null
    }
  ],
  "caption_instagram": "Caption directo sin hype. Máximo 3 líneas.\n\n#HashtagAmplio #NichoTema1 #NichoTema2 #KindaClub",
  "hashtags": ["#HashtagAmplio", "#NichoTema1", "#NichoTema2", "#KindaClub"]
}`;

  const raw      = await callGemini(prompt);
  const carousel = safeJsonParse(raw);
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
    console.log(`  ${i + 1}. [${s.score_total}] [${s.audience_type || 'artista'}] ${s.title}`);
  });

  // Respetar ratio 80/20: cada 5 posts, 1 es para profesionales
  const bl        = backlog.load();
  const published = bl.ideas.filter(i => i.status === 'published');
  const lastFive  = published.slice(-5);
  const profCount = lastFive.filter(i => i.audience_type === 'profesional').length;
  const needProf  = profCount === 0 && lastFive.length >= 4; // forzar uno profesional cada ~5

  let winner;
  if (needProf) {
    winner = sorted.find(s => s.audience_type === 'profesional') || sorted[0];
    console.log('[generate] Turno de contenido para PROFESIONALES (ratio 80/20)');
  } else {
    winner = sorted.find(s => s.audience_type !== 'profesional') || sorted[0];
  }

  const winnerId = backlog.ideaId(winner.title);
  console.log(`\n[generate] Ganador: "${winner.title}"`);
  console.log(`  Score: ${winner.score_total} | Audiencia: ${winner.audience_type || 'artista'} | Topic: ${pending.find(p => backlog.ideaId(p.title) === winnerId)?.topic_tag || '?'}`);

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
