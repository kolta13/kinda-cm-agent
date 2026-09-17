// ── Kinda CM Agent — Fase 2.5: Supervisor de calidad ─────────────────────
// Segunda pasada de Gemini, independiente de la que generó el copy, que revisa
// el carrusel contra la lista de errores reales que salieron publicados o casi
// salen publicados (ver historial de commits de generate.js/render.js del
// 2026-09-13/14). Existe porque confiar solo en las instrucciones del prompt
// de generación no basta: en esta misma sesión Gemini ignoró reglas explícitas
// del prompt en varias corridas seguidas (etiqueta forzada, título ambiguo,
// lista de errores disfrazada). Un segundo juicio, con el prompt enfocado
// SOLO en detectar fallas (no en escribir), es más confiable que confiar en
// que la primera pasada se autocorrija.
//
// No reemplaza los fixes deterministas ya hechos en código (normalizeEtiquetaWord,
// stripTitlePeriods, assertNoBrandMentions, etc.) — esos siguen corriendo antes.
// El supervisor cubre lo que es más semántico/de juicio y difícil de capturar
// con una regex: ambigüedad de lectura, promesas de portada vs. contenido,
// profundidad real de una conexión causal, y claims de producto inventados.
//
// Uso: node supervisor.js (revisa data/carousel_latest.json)

'use strict';
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const config  = require('./config');
const { withRetry } = require('./retry');

function httpPost(url, body) {
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
    const body  = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // temperature baja: acá queremos un juicio consistente, no creatividad.
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 4096 },
    });
    const raw  = await httpPost(url, body);
    const data = JSON.parse(raw);
    if (data.error) throw new Error(`Gemini error: ${data.error.message}`);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  }, { label: 'Gemini (supervisor)', retries: 5, baseDelayMs: 3000 });
}

function safeJsonParse(raw) {
  try { return JSON.parse(raw); }
  catch (_) {
    let inString = false, escaped = false, result = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped)                  { result += ch; escaped = false; continue; }
      if (ch === '\\' && inString)  { escaped = true; result += ch; continue; }
      if (ch === '"')               { inString = !inString; result += ch; continue; }
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

// Checklist de fallas reales — cada una salió publicada o casi sale publicada
// en esta cuenta. Se listan en el prompt con el ejemplo real para que Gemini
// juzgue con el mismo criterio con el que se corrigieron, no una versión
// vaga de la regla.
const CHECKLIST = `
1. PORTADA/ETIQUETA — número y sustantivo coherentes: si la portada promete una
   cantidad ("5 X"), el sustantivo X debe ser el mismo que usan las etiquetas de
   los slides de contenido, y el número debe coincidir con la cantidad real de
   slides. Ejemplo real que falló: portada "5 formatos de contenido" con slides
   "MITO 1", "MITO 2" — inconsistente.

2. HOOK AMBIGUO: la portada no debe empezar con un verbo sin sujeto explícito que
   se pueda leer como orden en vez de como hecho (el imperativo "tú" y la 3ra
   persona son idénticos en español). Ejemplo real que falló: "Identifica música
   IA: las nuevas reglas de Spotify" — sonaba a orden hasta el final de la frase.

3. NOMBRE DE PLATAFORMA EN EL TÍTULO: si el post trata sobre una o más
   plataformas/marcas nombradas (Spotify, TikTok, Instagram, YouTube, etc.), el
   nombre debe estar en el "titulo" de la portada, no solo en el "kicker".
   Ejemplo real que falló: kicker "SPOTIFY X TIKTOK", titulo "Dos plataformas:
   un plan de crecimiento real" (no nombra ninguna plataforma).

4. PROMESA DE PORTADA NO ENTREGADA: si la portada promete un resultado concreto
   (una cifra, un cálculo, una herramienta específica), el contenido debe
   entregarlo de verdad. Ejemplo real que falló: portada "Calcula cuánto pagan
   Spotify, Apple Music y más" pero el contenido nunca daba una cifra, y el CTA
   final ofrecía "una calculadora en kindaclub.com" que no existe.

5. FUNCIONES INVENTADAS DE KINDA CLUB: Kinda Club (kindaclub.com) SOLO tiene:
   catálogo de profesionales, perfil con portafolio, postulación de canciones a
   playlists, subida de proyectos, muro comunitario y mensajería directa.
   Prohibido mencionar calculadoras, dashboards, generadores, simuladores,
   comparadores o cualquier otra herramienta que Kinda Club no tenga.

6. CONEXIÓN SUPERFICIAL ENTRE PLATAFORMAS/HERRAMIENTAS: si el ángulo conecta dos
   plataformas o herramientas, no alcanza con describir el flujo de uso ("usa X
   para promocionar, luego manda esto a Y") — debe explicar el MECANISMO real por
   el que una alimenta a la otra (qué señal se traspasa y por qué le importa al
   algoritmo/curador del otro lado). Ejemplo real que falló: "Usa TikTok para
   generar buzz, luego dirige a tus seguidores a Spotify" (solo describe el
   flujo, no dice por qué funciona).

7. LISTA DE ERRORES/MITOS DISFRAZADA: no es una lista de frases a buscar — es un
   criterio de SIGNIFICADO. Lee el "titulo" de cada slide de contenido SOLO (sin el
   body) y pregúntate: "¿esta frase tal cual es algo FALSO o una mala práctica, que
   el lector necesita seguir leyendo para descubrir que en realidad está mal?" Si
   la respuesta es sí Y la portada no anunció explícitamente que el post trata de
   errores o mitos, dispara la regla — sin importar la forma gramatical (verbo
   negativo, "es solo X", "es suficiente", "son inaccesibles", "no aporta", "sigue
   sonando igual", "es la única", o cualquier otra construcción). Ejemplos reales
   que SÍ violaron esto, con formas todas distintas: "Ignorar el tráfico externo",
   "El estilo es solo el género", "La producción casera es suficiente",
   "Colaboraciones internacionales son inaccesibles", "El género urbano chileno
   suena siempre igual", "Lanzar singles sueltos es la única estrategia" — todos
   bajo portadas que prometían algo positivo ("crecimiento real", "factores de
   éxito"), nunca mitos. El formato asignado ese día puede ser MITO VS REALIDAD,
   pero la portada manda: si ella no prometió mitos, ningún título puede sonar a
   mito, en ninguna forma que se te ocurra evaluar.
   IMPORTANTE — esto NO aplica si el título nombra un HECHO, una ACCIÓN CORRECTA,
   o una CONSECUENCIA POSITIVA, aunque el "body" mencione de pasada qué hace mal
   la mayoría como contraste. Ejemplo que NO viola esta regla (título en
   positivo, no la marques): título "El tráfico externo cuenta" con body "La
   mayoría ignora esto, pero..." — el título nombra el hecho correcto, no la
   acción mala, así que está BIEN aunque el body mencione un contraste.
   Si tienes dudas y el título no empieza literalmente con una de esas palabras
   negativas, NO marques esta regla.

8. GENÉRICO/CONTENIDO DE RELLENO: cada "body" debe demostrar conocimiento real
   de la industria musical latinoamericana (un plazo de plataforma, un nombre de
   campo/herramienta exacto, un rango de precio real, una consecuencia
   contractual). Si un body podría aparecer en un carrusel de cualquier otro
   rubro cambiando dos palabras, es demasiado genérico.
`.trim();

function buildPrompt(carousel) {
  return `Eres el supervisor de calidad de Kinda Club (kindaclub.com), una red para la
industria musical de LATAM. Tu único trabajo es revisar el carrusel que otro proceso
generó y detectar si viola alguna de estas 8 reglas — NO reescribas el contenido, NO
seas condescendiente, solo audita.

═══ CHECKLIST (basado en fallas reales que salieron o casi salen publicadas) ═══
${CHECKLIST}

═══ CARRUSEL A REVISAR ═══
${JSON.stringify(carousel, null, 2)}

Responde SOLO con JSON válido:
{
  "aprobado": true,
  "problemas": [
    { "regla": 7, "slide": "titulo del slide afectado o 'portada'", "detalle": "qué está mal, en 1 oración concreta" }
  ]
}
"aprobado" es true SOLO si "problemas" queda vacío. Sé estricto pero justo: no inventes
problemas que no están en la checklist, y no marques algo como falla si cumple la regla
de forma razonable (no hace falta perfección literal, solo que no repita los errores
reales de la checklist).`;
}

// Revisa un carrusel ya generado. Devuelve { aprobado, problemas }.
async function reviewCarousel(carousel) {
  const raw    = await callGemini(buildPrompt(carousel));
  const result = safeJsonParse(raw);
  return {
    aprobado:  result.aprobado === true && (result.problemas || []).length === 0,
    problemas: result.problemas || [],
  };
}

// ── Ejecución directa (revisa carousel_latest.json) ─────────────────────────
async function main() {
  const carouselPath = path.join(__dirname, 'data', 'carousel_latest.json');
  const { carousel } = JSON.parse(fs.readFileSync(carouselPath, 'utf8'));
  console.log('[supervisor] Revisando:', carousel.tema);
  const review = await reviewCarousel(carousel);
  if (review.aprobado) {
    console.log('[supervisor] ✅ Aprobado, sin problemas detectados.');
  } else {
    console.log(`[supervisor] ❌ ${review.problemas.length} problema(s) detectado(s):`);
    review.problemas.forEach(p => console.log(`  - [Regla ${p.regla}] ${p.slide}: ${p.detalle}`));
  }
  return review;
}

if (require.main === module) {
  main().catch(e => { console.error('[supervisor] Error:', e.message); process.exit(1); });
}

module.exports = { reviewCarousel };
