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
const insights = require('./insights');

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
  // Las ideas promocionales (tema = promocionar Kinda Club) solo tienen sentido
  // en días de CTA directo. En un día de CTA blando el carrusel no puede vender,
  // y un post cuyo tema entero ES Kinda Club sin poder llamar a la acción queda
  // descolgado. getDailyCtaMode es una declaración de función (hoisted), así que
  // se puede llamar aunque esté definida más abajo.
  let candidatas = pending;
  if (getDailyCtaMode() !== 'directo') {
    const sinPromo = pending.filter(i => !i.is_promotional);
    if (sinPromo.length >= 3) {
      const excluidas = pending.length - sinPromo.length;
      if (excluidas > 0) {
        console.log(`[generate] ${excluidas} idea(s) promocional(es) excluida(s) — hoy el CTA es blando`);
      }
      candidatas = sinPromo;
    }
  }

  // Ordenar por score_total desc; ideas sin score van al final (score 0)
  const sorted = [...candidatas].sort((a, b) => (b.score_total || 0) - (a.score_total || 0));

  // Ratio 80/20: si los últimos 5 publicados no tienen ningún "profesional", forzar uno
  //
  // BUG (encontrado en revisión del 27-08-2026): bl.ideas mantiene el orden de
  // DESCUBRIMIENTO (cuándo se agregó al backlog), no el de publicación. Un
  // .slice(-5) sin ordenar por fecha real tomaba ideas descubiertas hace
  // semanas y publicadas fuera de orden — el sistema creía haber cumplido la
  // cuota de "profesional" cuando en realidad los últimos 5 posts REALES no
  // tenían ninguno. Resultado: 7 de los últimos 8 posts fueron para artistas.
  const bl        = backlog.load();
  const published = bl.ideas
    .filter(i => i.status === 'published')
    .sort((a, b) => (a.published_at || '').localeCompare(b.published_at || ''));
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
    etiqueta: 'PASO {n}',
    instruccion: 'Secuencia cronológica de acciones. Cada slide es un paso que depende del anterior. El lector debe poder ejecutarlos en orden hoy mismo.',
  },
  {
    nombre: 'MITO VS REALIDAD',
    etiqueta: 'MITO {n}',
    instruccion: 'Cada slide desarma una creencia común. Estructura del body: la creencia, y por qué es falsa con un dato. El titulo nombra el mito. No uses las palabras "mito" ni "realidad" literalmente en cada slide — se vuelve repetitivo.',
  },
  {
    nombre: 'ERROR Y CONSECUENCIA',
    etiqueta: 'ERROR {n}',
    instruccion: 'Cada slide es un error concreto que comete la audiencia, qué le cuesta (en dinero, tiempo u oportunidad perdida), y el arreglo. El titulo nombra el error, no la solución.',
  },
  {
    nombre: 'DESGLOSE DE UN NÚMERO',
    etiqueta: 'PARTE {n}',
    instruccion: 'Toma una cifra central del tema y descomponla. Cada slide desarma una parte de esa cifra. Ejemplo de armazón: "de cada USD 100 en streams, X se va en esto, Y en esto otro". Requiere cifras en TODOS los slides.',
  },
  {
    nombre: 'ANTES Y DESPUÉS',
    etiqueta: 'CASO {n}',
    instruccion: 'Cada slide contrasta cómo lo hace la mayoría contra cómo se hace bien. Estructura del body: el contraste concreto, no la moraleja. El titulo nombra la decisión en juego.',
  },
  {
    nombre: 'CHECKLIST DE VERIFICACIÓN',
    // Solo el número: "REVISA 1" no funciona porque es un verbo, y los verbos no
    // numeran ("revisa uno" no se dice). Las otras etiquetas son sustantivos
    // ("PASO 1", "MITO 2") y por eso sí leen bien.
    etiqueta: '{n}',
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

  // Cierre del ciclo: lo que el rendimiento real de posts anteriores sugiere.
  // Devuelve '' mientras no haya muestra suficiente, y en ese caso no se inyecta
  // nada — mejor que alimentar el prompt con una conclusión sacada de 1-2 posts.
  // Dos niveles de aprendizaje: el agregado (qué formato/tema/CTA rinde) y el
  // copy real de los mejores y peores posts. El segundo es el que enseña sobre
  // hooks y estructura — cosas que no se pueden promediar pero que el modelo sí
  // puede inferir viendo ejemplos con su resultado al lado.
  const aprendizajesTexto = [insights.aprendizajes(), insights.ejemplosDeCopy()]
    .filter(Boolean)
    .join('\n\n');
  if (aprendizajesTexto) {
    console.log('[generate] Inyectando aprendizajes de rendimiento al prompt');
  }

  const prompt = `Eres el creador de contenido de Kinda Club (kindaclub.com). Tu tono es técnico, minimalista, directo y de colega a colega. Hablas como un productor o creativo independiente experimentado, nunca como una agencia de marketing.

El tema del carrusel es: "${winner.title}"
Ángulo: ${winner.angulo}
Por qué funciona: ${winner.por_que}
Audiencia: ${winner.audience_type === 'profesional' ? 'PROFESIONALES DE LA MÚSICA (productores, mezcladores, managers — cómo conseguir clientes, mostrar portafolio, definir tarifas)' : 'ARTISTAS INDEPENDIENTES (lanzamientos, presupuesto, encontrar equipo, procesos, feedback)'}

═══ REGLAS EDITORIALES (OBLIGATORIAS) ═══

${aprendizajesTexto ? aprendizajesTexto + '\n\n' : ''}FORMATO DEL CARRUSEL DE HOY: ${formato.nombre}
${formato.instruccion}
Este formato es obligatorio hoy. Si el tema no encaja perfecto con él, adapta el ángulo del tema al formato — no cambies el formato. La variedad entre publicaciones importa más que el encaje perfecto de un tema puntual.

CANTIDAD DE SLIDES: Entre 3 y 8 slides en total (portada + contenido + cta). Sin relleno. Solo los slides que el tema justifica.

═══ REGLA #1: ESPECIFICIDAD (la más importante) ═══

El problema más grave del contenido genérico es que suena a IA que no sabe nada del rubro. Cada slide debe demostrar conocimiento real de la industria musical latinoamericana.

TEST OBLIGATORIO — aplícalo a cada "body" antes de escribirlo:
"¿Este texto podría aparecer tal cual en un carrusel de CUALQUIER otro rubro (marketing digital, fitness, finanzas) cambiando dos palabras?"
Si la respuesta es sí, está mal. Reescríbelo.

Todo "body" DEBE contener al menos UNO de estos anclajes concretos:
- Un plazo o regla documentada de una plataforma ("Spotify pide el pitch 7 días antes
  del lanzamiento", "el editorial se revisa una vez por semana")
- El nombre exacto de un campo, formato, herramienta o documento ("la pestaña de pitch
  en Spotify for Artists", "cláusula de exclusividad territorial", "WAV 24bit/48kHz")
- Un rango de precio de mercado, presentado COMO RANGO ("una mezcla profesional en LATAM
  va de USD 80 a 250 por canción")
- Una consecuencia contractual o técnica que se deduce del propio hecho ("si el contrato
  dice territorio mundial a perpetuidad, no recuperas el máster nunca")

═══ REGLA #1b: SOLO DATOS VERIFICABLES PÚBLICAMENTE ═══

CRÍTICO. Kinda Club educa sobre contratos, regalías y plataformas: publicar una cifra
inventada destruye la credibilidad de la cuenta. NO tienes fuentes que consultar, así
que solo puedes afirmar lo que es verificable públicamente por cualquiera.

PROHIBIDO ABSOLUTAMENTE — estadísticas de resultado que suenan creíbles pero no puedes
respaldar:
- Porcentajes de mejora o rendimiento: "genera un 30% más", "aumenta tus streams 5x",
  "multiplica tu alcance por 3", "sube un 40% tus reproducciones".
- Porcentajes de población sin fuente: "el 80% de los artistas comete este error",
  "9 de cada 10 independientes fracasan".
- Pagos por stream exactos: "Spotify paga USD 0,004 por reproducción" (varía por país,
  contrato y período — citarlo como dato fijo es falso).
- Cualquier cifra que responda "¿cuánto mejora/crece?" en vez de "¿cuánto cuesta/dura?".

SÍ PERMITIDO — hechos que cualquiera puede confirmar:
- Reglas y plazos publicados por las plataformas.
- Especificaciones técnicas (formatos de archivo, resoluciones, requisitos de subida).
- Rangos de precio de mercado, siempre como rango y no como precio único.
- Mecánicas contractuales y qué implica cada cláusula.
- Aritmética evidente ("un acuerdo a 7 años son 7 años sin poder relicenciar").

SI NO TIENES UN DATO VERIFICABLE, usa una comparación cualitativa honesta en vez de
inventar un número. Es mejor decir menos que decir algo falso.
- MAL:  "Licenciar genera un 30% más que vender el máster."
- BIEN: "Licenciar mantiene el máster a tu nombre; venderlo lo entrega de forma definitiva."

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

PORTADA (slide 1) — LA PROMESA:
- Objetivo: que el lector sepa EXACTAMENTE qué se lleva si desliza. Contenido educativo
  para un nicho: la promesa clara convierte mejor que la intriga críptica.
- Estructura obligatoria de la portada, dos partes:
  1. "kicker": la categoría específica, 2-4 palabras, en mayúsculas. Es el sello de sección.
     Ejemplos buenos: "SPOTIFY 101", "SPOTIFY x META ADS", "ARTISTA EMERGENTE",
     "ARTISTAS INDEPENDIENTES", "CONTRATOS 101", "MEZCLA Y MASTER".
     Debe nombrar la plataforma o el subtema real, NO una categoría genérica como
     "MARKETING" o "DISTRIBUCIÓN" a secas.
  2. "titulo": la promesa concreta de lo que el carrusel entrega. 5 a 9 palabras,
     nunca más. Un título largo ocupa toda la portada y pierde impacto visual.
     Si el tema original es una frase larga, RESÚMELO — no lo copies.
     Ejemplo MALO (13 palabras, ocupa 7 líneas): "Derechos de autor y patentes:
     genera ingresos recurrentes fuera del mercado tradicional"
     Ejemplo BIEN (6 palabras): "Cómo cobrar regalías toda tu vida"
- FORMATOS DE TÍTULO que funcionan (todos anuncian el contenido, no lo esconden):
  · Lista numerada: "3 errores que cometen los artistas al lanzar música"
  · Ranking: "Top 3 distribuidoras musicales en 2026"
  · Pregunta directa del tema: "¿Cómo Spotify decide a quién recomendar?"
  · Desglose: "3 pilares de tu identidad artística"
  · Cómo-hacer: "Cómo crecer en Spotify con Meta Ads"
- Si el formato del día implica una cantidad (3 errores, 4 pasos, 3 pilares), el número
  DEBE aparecer en el título y coincidir con la cantidad real de slides de contenido.
- PROHIBIDO: intriga sin promesa ("Tu demo llegó y nadie la escuchó", "El 90% lo hace al
  revés"). Suena a clickbait y no dice qué se lleva el lector. Tampoco frases sueltas sin
  sustantivo del tema.
- La portada NO lleva "body" (queda null).

SLIDE 2 — ENTRADA DIRECTA AL CONTENIDO:
- Como la portada ya dijo de qué trata, el slide 2 NO necesita re-presentar el tema:
  entra directo al primer punto real usando la etiqueta estructural del formato de hoy.
- El "titulo" del slide 2 ya puede ser el primer ítem etiquetado ("ERROR 1: LANZAR SIN
  FECHA", "PILAR 1: TU SONIDO", "PASO 1: ...") — ver ETIQUETAS ESTRUCTURALES abajo.
- PROHIBIDO que sea una LISTA de sub-puntos separados por comas o dos puntos
  (ej. "Marketing: Marca, Audiencia y Comunidad" — eso es un índice, no un título). El
  titulo del slide 2 es UNA sola idea, no una enumeración de todo lo que
  viene después. Ejemplo MALO (lista): "Marketing: Marca, Audiencia y Comunidad." Ejemplo
  BUENO (frase única): "Así funciona el marketing real."
  viene después.

ETIQUETAS ESTRUCTURALES (campo aparte, NO dentro del título):
- Cada slide de contenido lleva un campo "etiqueta" que marca dónde está el lector dentro
  del carrusel. Se renderiza en otro color y tamaño que el título, así que va SEPARADO.
- La etiqueta de hoy es exactamente: "${formato.etiqueta}" (reemplaza {n} por el número
  correlativo del slide: 1, 2, 3...). No inventes otra ni la traduzcas.
- PROHIBIDO meter la etiqueta dentro del "titulo". El título NO empieza con "PASO 1:",
  "MITO 2:" ni nada parecido — esa parte va solo en el campo "etiqueta".
  MAL:  etiqueta: "PASO 1", titulo: "PASO 1: Define tu concepto"
  BIEN: etiqueta: "PASO 1", titulo: "Define tu concepto"
- La numeración debe ser correlativa y coincidir con el número prometido en la portada.

SLIDES DE CONTENIDO (general):
- 2 niveles de lectura obligatorios:
  1. "etiqueta": la etiqueta estructural del formato de hoy (ver arriba).
  2. "titulo": SOLO el nombre concreto del punto, 2 a 5 palabras. Sin la etiqueta adentro,
     sin punto final.
  3. "body": 18 a 30 palabras. Debe cumplir la REGLA #1 de especificidad.
     Tiene espacio para dar contexto real, no solo una instrucción telegráfica: explica
     el QUÉ y el POR QUÉ, con el dato concreto adentro.
     Ejemplo del largo correcto: "No es el género — es la textura que te hace reconocible
     entre mil canciones. Tu voz, tus instrumentos, tu forma de producir."
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
- Estructura que funciona: una frase que plantea el problema o la pregunta del carrusel,
  cerrando con 👇 para invitar a deslizar. Luego línea en blanco y los hashtags.
  Ejemplos reales que funcionaron:
  · "3 errores que vemos repetirse una y otra vez 👇"
  · "¿Sabías que puedes usar Meta Ads para darle instrucciones a Spotify? 👇"
  · "El algoritmo de Spotify no es magia — son datos. Y si entiendes los 3 números que
     mira, puedes trabajar a tu favor. 👇"
- Máximo 3 líneas + línea en blanco + exactamente 4 hashtags.
- Hashtags: 1 amplio LATAM (#Musicos o #MusicaLatina) + 2 de nicho del tema + #KindaClub.
- Sin exclamaciones. Emojis: máximo 2 (el 👇 del final cuenta como uno).

Responde SOLO con JSON válido:
{
  "tema": "tema del carrusel",
  "angulo": "ángulo elegido",
  "audience_type": "artista",
  "slides": [
    {
      "numero": 1,
      "tipo": "portada",
      "kicker": "SPOTIFY 101",
      "titulo": "Promesa concreta de lo que entrega el carrusel, 6-12 palabras",
      "subtitulo": null,
      "body": null
    },
    {
      "numero": 2,
      "tipo": "contenido",
      "etiqueta": "ERROR 1",
      "titulo": "NOMBRE DEL PUNTO",
      "subtitulo": null,
      "body": "18 a 30 palabras con el dato concreto adentro, explicando el qué y el por qué."
    },
    {
      "numero": 3,
      "tipo": "contenido",
      "etiqueta": "ERROR 2",
      "titulo": "NOMBRE DEL PUNTO",
      "subtitulo": null,
      "body": "18 a 30 palabras. Mismo nivel de especificidad, sin relleno."
    },
    {
      "numero": 4,
      "tipo": "cta",
      "titulo": "Cierre según el modo de CTA de hoy, max 12 palabras",
      "subtitulo": null,
      "body": null
    }
  ],
  "caption_instagram": "Frase que plantea el problema del carrusel 👇\n\n#HashtagAmplio #NichoTema1 #NichoTema2 #KindaClub",
  "hashtags": ["#HashtagAmplio", "#NichoTema1", "#NichoTema2", "#KindaClub"]
}`;

  const raw      = await callGemini(prompt);
  const carousel = safeJsonParse(raw);
  const clean    = neutralizeSpanish(carousel);
  stripTitlePeriods(clean);
  normalizeAudienceType(clean);
  warnFirstPerson(clean);
  warnUnverifiableStats(clean);
  assertNoBrandMentions(clean);
  return clean;
}

// Detecta estadísticas de resultado que el modelo no puede respaldar ("genera un
// 30% más", "5x más streams", "el 80% de los artistas..."). La regla de
// especificidad empuja a dar cifras y Gemini tiende a inventar las que no sabe —
// para una cuenta que educa sobre contratos y regalías eso es un riesgo real de
// credibilidad. Solo advierte, no bloquea: queda en el log del run y en el email
// de notificación para poder revisar el post publicado.
const UNVERIFIABLE_STAT_PATTERNS = [
  // porcentaje seguido (cerca) de un verbo de mejora/crecimiento
  /\b\d{1,3}\s?%\s+(más|menos|mayor|de aumento|de crecimiento|de mejora)/i,
  /(aumenta|incrementa|mejora|sube|crece|multiplica|reduce)[^.]{0,40}\b\d{1,3}\s?%/i,
  // multiplicadores tipo "3x más", "duplica tus streams"
  /\b\d{1,2}\s?x\s+(más|mayor)/i,
  /\b(duplica|triplica|multiplica)\s+(tus|tu|el|la)\b/i,
  // "N de cada M" y "el N% de los artistas/músicos/independientes"
  /\b\d{1,2}\s+de\s+cada\s+\d{1,2}\b/i,
  /\bel\s+\d{1,3}\s?%\s+de\s+(los|las)\b/i,
  // pago por stream citado como cifra fija
  /(USD|US\$|\$)\s?0[.,]\d{3,}\s*(por|\/)\s*(stream|reproducci)/i,
];

function warnUnverifiableStats(carousel) {
  const text  = JSON.stringify(carousel);
  const found = UNVERIFIABLE_STAT_PATTERNS.filter(re => re.test(text));
  if (found.length > 0) {
    const matches = found.map(re => (text.match(re) || [''])[0].trim()).filter(Boolean);
    console.warn(`[generate] ⚠ Posible estadística no verificable (revisar antes de dar por bueno el post): ${matches.join(' | ')}`);
  }
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

// Gemini a veces devuelve variantes del audience_type en vez de los dos valores
// del schema ("artista" / "profesional") — el post del 28-08-2026 quedó guardado
// como "profesional_musica". No rompe la selección (selectWinner lee el valor
// del backlog, que viene del scoring), pero sí ensucia post_history.json, que es
// el dataset que usamos para las retrospectivas de balance 80/20.
function normalizeAudienceType(carousel) {
  const raw = String(carousel.audience_type || '').toLowerCase();
  carousel.audience_type = raw.includes('profesional') ? 'profesional' : 'artista';
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
    // Se guardan para el ciclo de aprendizaje: son las dos variables que el
    // sistema controla y rota, así que son las que se pueden correlacionar
    // contra el rendimiento del post. Sin esto el análisis no puede responder
    // "¿qué formato funciona mejor?", que es justamente la pregunta útil.
    formato:      getDailyFormat().nombre,
    cta_mode:     getDailyCtaMode(),
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

module.exports = { generate, selectWinner, getDailyFormat, getDailyCtaMode };
