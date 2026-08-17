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
const { withRetry } = require('./retry');

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
  return withRetry(async () => {
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
  }, { label: 'Gemini (generate)' });
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

// ── Fase 2a: Selección del ganador ───────────────────────────────────────
// Las ideas ya vienen puntuadas desde research.js (score.js).
// Solo ordenamos por score y aplicamos las reglas de ratio.

function selectWinner(pending) {
  // Ordenar por score_total desc; ideas sin score van al final (score 0)
  const sorted = [...pending].sort((a, b) => (b.score_total || 0) - (a.score_total || 0));

  // Ratio 80/20: si los últimos 5 publicados no tienen ningún "profesional", forzar uno
  const bl        = backlog.load();
  const published = bl.ideas.filter(i => i.status === 'published');
  const lastFive  = published.slice(-5);
  const profCount = lastFive.filter(i => i.audience_type === 'profesional').length;
  const needProf  = profCount === 0 && lastFive.length >= 4;

  let winner;
  if (needProf) {
    winner = sorted.find(s => s.audience_type === 'profesional') || sorted[0];
    console.log('[generate] Turno de contenido para PROFESIONALES (ratio 80/20)');
  } else {
    winner = sorted.find(s => s.audience_type !== 'profesional') || sorted[0];
  }

  return { winner, sorted };
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

  const scoredCount = pending.filter(p => p.score_total !== null).length;
  console.log(`[generate] ${pending.length} ideas pendientes (${scoredCount} con score, ${pending.length - scoredCount} sin score)`);

  // Seleccionar ganador por score (ya calculado en research.js via score.js)
  const { winner, sorted } = selectWinner(pending);

  console.log('\n[generate] Top 5 ideas:');
  sorted.slice(0, 5).forEach((s, i) => {
    console.log(`  ${i + 1}. [${s.score_total ?? 'sin score'}] [${s.audience_type || '?'}] ${s.title}`);
  });

  const winnerId = backlog.ideaId(winner.title);
  console.log(`\n[generate] Ganador: "${winner.title}"`);
  console.log(`  Score: ${winner.score_total} | Audiencia: ${winner.audience_type || 'artista'} | Topic: ${winner.topic_tag || '?'}`);

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
