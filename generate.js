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

// ── Formatos de carrusel (rotación diaria) ────────────────────────────────
// Sin esto, Gemini escribe SIEMPRE un listicle ("N pasos para X"). Revisión
// del 27-08-2026: los 5 posts anteriores tenían estructura idéntica. Rotar el
// formato por día garantiza variedad real en el feed en vez de confiar en que
// el modelo varíe solo.

const CARRUSEL_FORMATS = [
  {
    nombre: 'PASO A PASO',
    instruccion: 'Secuencia cronológica de acciones. Cada slide es un paso que depende del anterior. El lector debe poder ejecutarlos en orden hoy mismo.',
  },
  {
    nombre: 'MITO VS REALIDAD',
    instruccion: 'Cada slide desarma una creencia común. Estructura del body: la creencia, y por qué es falsa con un dato. El titulo nombra el mito. No uses las palabras "mito" ni "realidad" literalmente en cada slide — se vuelve repetitivo.',
  },
  {
    nombre: 'ERROR Y CONSECUENCIA',
    instruccion: 'Cada slide es un error concreto que comete la audiencia, qué le cuesta (en dinero, tiempo u oportunidad perdida), y el arreglo. El titulo nombra el error, no la solución.',
  },
  {
    nombre: 'DESGLOSE DE UN NÚMERO',
    instruccion: 'Toma una cifra central del tema y descomponla. Cada slide desarma una parte de esa cifra. Ejemplo de armazón: "de cada USD 100 en streams, X se va en esto, Y en esto otro". Requiere cifras en TODOS los slides.',
  },
  {
    nombre: 'ANTES Y DESPUÉS',
    instruccion: 'Cada slide contrasta cómo lo hace la mayoría contra cómo se hace bien. Estructura del body: el contraste concreto, no la moraleja. El titulo nombra la decisión en juego.',
  },
  {
    nombre: 'CHECKLIST DE VERIFICACIÓN',
    instruccion: 'Cada slide es algo que el lector debe revisar/confirmar antes de avanzar, con el criterio exacto de qué buscar. No "revisa el contrato" sino qué cláusula y qué número específico mirar.',
  },
];

function getDailyFormat() {
  const dayIndex = Math.floor(Date.now() / 86400000);
  return CARRUSEL_FORMATS[dayIndex % CARRUSEL_FORMATS.length];
}

// El CTA no puede vender todos los días. Revisión del 27-08-2026: 5 de 5 posts
// terminaban empujando a kindaclub.com, lo que hace que la cuenta se lea como
// publicidad. 2 de cada 3 días el cierre es de valor/comunidad, no transaccional.
function getDailyCtaMode() {
  const dayIndex = Math.floor(Date.now() / 86400000);
  return dayIndex % 3 === 0 ? 'directo' : 'blando';
}

// ── Fase 2b: Generación de copy ───────────────────────────────────────────

async function generateCarousel(winner) {
  const formato = getDailyFormat();
  const ctaMode = getDailyCtaMode();
  console.log(`[generate] Generando carrusel para: "${winner.title}"`);
  console.log(`[generate] Formato de hoy: ${formato.nombre} | CTA: ${ctaMode}`);

  const prompt = `Eres el creador de contenido de Kinda Club (kindaclub.com). Tu tono es técnico, minimalista, directo y de colega a colega. Hablas como un productor o creativo independiente experimentado, nunca como una agencia de marketing.

El tema del carrusel es: "${winner.title}"
Ángulo: ${winner.angulo}
Por qué funciona: ${winner.por_que}
Audiencia: ${winner.audience_type === 'profesional' ? 'PROFESIONALES DE LA MÚSICA (productores, mezcladores, managers — cómo conseguir clientes, mostrar portafolio, definir tarifas)' : 'ARTISTAS INDEPENDIENTES (lanzamientos, presupuesto, encontrar equipo, procesos, feedback)'}

═══ REGLAS EDITORIALES (OBLIGATORIAS) ═══

FORMATO DEL CARRUSEL DE HOY: ${formato.nombre}
${formato.instruccion}
Este formato es obligatorio hoy. Si el tema no encaja perfecto con él, adapta el ángulo del tema al formato — no cambies el formato. La variedad entre publicaciones importa más que el encaje perfecto de un tema puntual.

CANTIDAD DE SLIDES: Entre 3 y 8 slides en total (portada + contenido + cta). Sin relleno. Solo los slides que el tema justifica.

═══ REGLA #1: ESPECIFICIDAD (la más importante) ═══

El problema más grave del contenido genérico es que suena a IA que no sabe nada del rubro. Cada slide debe demostrar conocimiento real de la industria musical latinoamericana.

TEST OBLIGATORIO — aplícalo a cada "body" antes de escribirlo:
"¿Este texto podría aparecer tal cual en un carrusel de CUALQUIER otro rubro (marketing digital, fitness, finanzas) cambiando dos palabras?"
Si la respuesta es sí, está mal. Reescríbelo.

Todo "body" DEBE contener al menos UNO de estos anclajes concretos:
- Una cifra (porcentaje, monto en USD, cantidad, duración)
- Un plazo específico ("7 días antes", "las primeras 48 horas")
- El nombre exacto de un campo, formato, herramienta o documento ("la pestaña de pitch en Spotify for Artists", "cláusula de exclusividad territorial", "archivo WAV 24bit/48kHz")
- Una consecuencia verificable ("pierdes el placement de esa semana", "cedes el máster por 7 años")

VERBOS PROHIBIDOS como acción principal — son huecos y no dicen nada:
"investiga", "busca", "define tus objetivos", "prepara", "sé claro", "conoce", "organiza", "planifica", "asegúrate de entender", "ten en cuenta".
Solo se permiten si van seguidos de QUÉ exactamente y CON QUÉ criterio.

EJEMPLOS REALES DE LO QUE NO SIRVE (salieron publicados, son el error a evitar):
- MAL: "Busca en plataformas, revisa portafolios y escucha sus trabajos previos."
  BIEN: "Pide 3 referencias en tu mismo género y precio cerrado por canción, nunca por hora."
- MAL: "Define tu género, presupuesto y objetivos antes de buscar."
  BIEN: "Mezcla profesional en LATAM va de USD 80 a 250 por canción. Cotiza 3 antes de decidir."
- MAL: "Asegúrate de entender dónde se distribuirá tu música."
  BIEN: "Si el contrato dice territorio mundial y a perpetuidad, no puedes recuperar el máster nunca."

Si no tienes un dato concreto real para un punto, ELIMINA ese slide. Un carrusel de 3 slides con sustancia vale más que uno de 7 con relleno.

TÍTULOS DE RELLENO PROHIBIDOS — no aportan y gastan un slide:
"El resultado final", "En resumen", "La conclusión", "Lo más importante", "Para terminar",
"El siguiente paso", "Consideraciones finales". Cada título nombra algo concreto o no existe.

FRASES PUBLICITARIAS PROHIBIDAS — suenan a folleto, no a colega:
"calidad de estudio", "sin salir de casa", "resultados profesionales", "lleva tu música al
siguiente nivel", "todo lo que necesitas", "la clave del éxito", "sin complicaciones".

═══ REGLA #2: VOZ — nunca en primera persona ═══

El tema de hoy puede venir de un título ajeno escrito en primera persona ("Cómo HICE mi
videoclip", "Así es como GRABAMOS..."). Kinda Club NO vivió esa experiencia: es una
plataforma, no un artista. Apropiarse de la historia de otro es deshonesto y se nota.

PROHIBIDO en slides y caption: "hice", "hicimos", "grabé", "grabamos", "mi videoclip",
"nuestro lanzamiento", "cuando yo empecé", o cualquier relato en primera persona de una
experiencia personal.

Reformula siempre a segunda persona (instrucción al lector) o a tercera (dato del rubro):
- MAL:  "Hice un videoclip animado con el móvil por menos de USD 50."
- BIEN: "Un videoclip animado con celular sale bajo USD 50 en props y dos días de edición."
- BIEN: "Puedes grabar un videoclip animado con tu celular por menos de USD 50."

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

SLIDE 2 — LA REVELACIÓN (bisagra obligatoria entre portada y contenido):
- La portada abre un gap de curiosidad sin decir de qué trata el carrusel. El SLIDE 2 tiene
  la obligación de CERRAR ese gap: su "titulo" debe nombrar el tema explícitamente para que
  portada + slide 2 juntos se entiendan como una idea completa.
- PROHIBIDO que el titulo del slide 2 sea un marcador genérico sin contexto: "Paso 1",
  "Primero", "Define tu plan", "El primer error" — el lector no sabe plan/error DE QUÉ.
  El titulo debe incluir el sustantivo del tema (lanzamiento, mezcla, booking, tarifas, etc.).
  Ejemplo MALO (sin contexto): portada "El 90% lo hace al revés." → slide 2 "Paso 1: Define
  tu plan" (no dice plan de qué). Ejemplo BUENO: → slide 2 "Así se arma un lanzamiento"
  (nombra el tema — lanzamiento — y recién ahí el body entra en la mecánica del paso 1).
- PROHIBIDO también que sea una LISTA de sub-puntos separados por comas o dos puntos
  (ej. "Marketing: Marca, Audiencia y Comunidad" — eso es un índice, no un gancho). El
  titulo del slide 2 es UNA sola frase corta y directa, no una enumeración de todo lo que
  viene después. Ejemplo MALO (lista): "Marketing: Marca, Audiencia y Comunidad." Ejemplo
  BUENO (frase única): "Así funciona el marketing real."
- A partir del slide 3, ya con el tema establecido, sí pueden ser pasos numerados directos
  ("Paso 2", "Paso 3") sin repetir el contexto cada vez.

SLIDES DE CONTENIDO (general):
- 2 niveles de lectura obligatorios:
  1. "titulo": 3 a 6 palabras. Ancla la atención. Sin punto final.
  2. "body": 12 a 18 palabras exactas. Debe cumplir la REGLA #1 de especificidad.
- Límite total por slide: 25 palabras entre titulo + body.
- La estructura la define el FORMATO DEL CARRUSEL DE HOY (arriba), no elijas otra.
- PROHIBIDO: explicaciones teóricas densas, frases de relleno, consejos que el lector ya sabe.

SLIDE FINAL / CTA — modo de hoy: ${ctaMode.toUpperCase()}
${ctaMode === 'directo'
  ? `- Llamado directo y transaccional a kindaclub.com.
- Si es para ARTISTAS: subir proyecto, buscar equipo en el catálogo o postular canción a playlists.
- Si es para PROFESIONALES: crear perfil, subir portafolio y definir tarifas.`
  : `- HOY NO SE VENDE. El cierre es de valor, no transaccional. Una cuenta que pide algo en
  cada publicación se lee como publicidad y la gente deja de seguirla.
- Opciones válidas para hoy (elige la que cierre mejor el tema):
  · Cierre con la idea más fuerte del carrusel reformulada como conclusión.
  · Pregunta genuina a la comunidad que invite a comentar su experiencia.
  · Recordatorio de guardar el carrusel para cuando lo necesite.
- Puedes mencionar Kinda Club al pasar, pero NO como llamado a la acción principal.
- PROHIBIDO hoy: "postula", "crea tu perfil", "únete", "conecta en kindaclub.com".`}
- Máximo 10-12 palabras en titulo.
- body del CTA: null (solo el titulo basta).

LISTA NEGRA — NUNCA USAR:
- Palabras: "Descubre", "Potencia", "Revoluciona", "El secreto para", "En el dinámico mundo de la música".
- Signos de exclamación (¡ !). Cero.
- Voseo argentino: "vos/tenés/conectás/hacés". Usar siempre "tú/tienes/conecta/haces".
- Chilenismos ni jerga regional.
- Marcas/distribuidoras/herramientas de terceros (DistroKid, TuneCore, CD Baby, Symphonic
  Distribution, AWAL, etc.): SÍ puedes nombrarlas, pero SOLO como parte de una lista neutral
  de 2 o más opciones existentes en el mercado ("DistroKid, TuneCore o CD Baby son algunas
  opciones"). PROHIBIDO destacar, recomendar o mencionar una sola marca específica de forma
  aislada — eso se lee como publicidad gratuita a un negocio ajeno y Kinda Club no hace eso.
  Si no vas a nombrar 2+ opciones, usa términos genéricos: "tu distribuidora", "una plataforma
  de distribución". Nunca nombres agencias de marketing o consultoras específicas (ej. Sarbide
  Music) bajo ninguna circunstancia — no son "opciones intercambiables" como los distribuidores.

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
      "titulo": "Nombra el tema explícitamente (no 'Paso 1' genérico)",
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
  const clean    = neutralizeSpanish(carousel);
  stripTitlePeriods(clean);
  warnFirstPerson(clean);
  assertNoBrandMentions(clean);
  return clean;
}

// Detecta relatos en primera persona (Kinda Club apropiándose de la experiencia
// de otro, porque la idea vino de un título ajeno tipo "Cómo HICE mi videoclip").
// Solo advierte, NO bloquea: un caption con voz equivocada es un problema menor
// comparado con quedarse sin publicar ese día.
const FIRST_PERSON_PATTERNS = [
  /\bhice\b/i, /\bhicimos\b/i, /\bgrabé\b/i, /\bgrabamos\b/i, /\blancé\b/i,
  /\blanzamos\b/i, /\bconseguí\b/i, /\bconseguimos\b/i, /\baprendí\b/i,
  /\bmi (primer|primera|videoclip|disco|single|lanzamiento|carrera)\b/i,
  /\bnuestro (videoclip|disco|single|lanzamiento)\b/i,
];

function warnFirstPerson(carousel) {
  const text  = JSON.stringify(carousel);
  const found = FIRST_PERSON_PATTERNS.filter(re => re.test(text));
  if (found.length > 0) {
    console.warn(`[generate] ⚠ Posible relato en primera persona (Kinda Club no vivió esa experiencia): ${found.map(r => r.source).join(', ')}`);
  }
}

// Quita el punto final de los títulos de slide. En display de 82-108px un punto
// colgando al final se ve anticuado y además queda visualmente despegado por el
// letter-spacing negativo. Los "body" SÍ conservan su puntuación normal.
function stripTitlePeriods(carousel) {
  (carousel.slides || []).forEach(s => {
    if (typeof s.titulo === 'string') {
      s.titulo = s.titulo.replace(/\s*\.\s*$/, '').trim();
    }
  });
}

// ── Guardia de marcas de terceros ─────────────────────────────────────────
// Última línea de defensa contra publicidad involuntaria a un solo negocio.
//
// Distribuidoras (DISTRIBUTOR_BRANDS): son "opciones intercambiables" — está
// bien nombrarlas SI aparecen 2 o más juntas como lista neutral. Si aparece
// una sola, se lee como recomendación/promoción de esa marca → se bloquea.
//
// Agencias/consultoras (AGENCY_BRANDS): nunca son una "opción" genérica que
// listar — nombrarlas siempre suena a publicidad de un negocio específico
// (pasó con "Sarbide Music"). Se bloquean sin importar cuántas aparezcan.

const DISTRIBUTOR_BRANDS = [
  'distrokid', 'tunecore', 'cd baby', 'cdbaby', 'symphonic', 'awal',
  'believe digital', 'unitedmasters', 'amuse', 'ditto music',
  'record union', 'imusician', 'routenote',
];

const AGENCY_BRANDS = [
  'sarbide', 'sarbide music', 'soundbetter', 'fiverr', 'upwork',
  'songtradr', 'groover', 'submithub', 'feature.fm', 'linkfire', 'toneden',
];

function assertNoBrandMentions(carousel) {
  const allText = JSON.stringify(carousel).toLowerCase();

  const agencyFound = AGENCY_BRANDS.filter(brand => allText.includes(brand));
  if (agencyFound.length > 0) {
    throw new Error(`Carrusel menciona agencia/consultora de terceros: ${agencyFound.join(', ')} — nunca se permite, sin importar el contexto.`);
  }

  const distributorsFound = DISTRIBUTOR_BRANDS.filter(brand => allText.includes(brand));
  if (distributorsFound.length === 1) {
    throw new Error(`Carrusel menciona una sola distribuidora ("${distributorsFound[0]}") sin presentarla como parte de una lista de opciones — se lee como promoción de esa marca.`);
  }
  // 0 menciones: OK. 2+ menciones: OK, se asume lista neutral de opciones.
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
  let carousel;
  try {
    carousel = await generateCarousel(winner);
  } catch (err) {
    // Si el guard de marcas de terceros (u otro fallo de generación) tumba esta idea,
    // descartarla del backlog para no reintentarla mañana con el mismo resultado.
    backlog.markSkipped(winnerId, err.message);
    console.error(`[generate] Idea "${winner.title}" descartada del backlog: ${err.message}`);
    throw err;
  }

  const today  = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const output = {
    generated_at: new Date().toISOString(),
    week:         today,
    winner_score: winner.score_total,
    backlog_id:   winnerId,
    topic_tag:    winner.topic_tag || 'general', // para el badge de la portada en render.js
    top_10:       sorted.slice(0, 10), // preview de las candidatas mejor puntuadas, no el backlog completo
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
