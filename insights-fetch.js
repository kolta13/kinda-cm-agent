// ── Kinda CM Agent — Ingesta automática de métricas de Instagram ────────
// Cierra el loop de aprendizaje: hasta el 2026-09-16, insights.js dependía
// 100% de que alguien cargara métricas a mano (node insights.js set ...) y
// nunca se había hecho ni una vez en 31 posts — todo el motor de rankeo/ajuste
// por topic (insights.js) corría en el vacío desde que existe.
//
// Este módulo consulta el Graph API de Meta por los posts de Instagram ya
// publicados que todavía no tienen métricas, y con al menos MIN_AGE_HOURS de
// antigüedad (mirar el engagement al toque no sirve, hay que dejar que se
// asiente). TikTok queda afuera a propósito: los posts quedan como borrador
// manual en la app (no hay Direct Post aprobado), así que no hay un post_id
// público que consultar vía API hasta que alguien lo termine a mano — ese
// caso sigue siendo `node insights.js set <id> ... ` manual.
//
// REQUIERE el scope `instagram_manage_insights` en metaAccessToken — el token
// actual (2026-09-16) NO lo tiene (solo pages_show_list, business_management,
// instagram_basic, instagram_content_publish). Sin ese scope, Graph API
// devuelve "(#10) Application does not have permission for this action" y
// esta función lo loguea como warning y sigue sin romper el ciclo. Para
// habilitarlo: Graph API Explorer → app "Kinda CM Publisher" → agregar
// instagram_manage_insights a los permisos → generar token corto → correr
// `node get-long-token.js <APP_ID> <APP_SECRET>` (ya existe, intercambia por
// uno de 60 días) → actualizar el secret META_ACCESS_TOKEN en GitHub.
//
// Uso: node insights-fetch.js

'use strict';
const https   = require('https');
const config  = require('./config');
const history = require('./history');

const MIN_AGE_HOURS = 24;
const METRICS_QUERY = 'reach,likes,comments,shares,saved,total_interactions';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('Respuesta no es JSON: ' + Buffer.concat(chunks).toString('utf8').slice(0, 200))); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('Timeout')); });
  });
}

// Instagram no expone "views" para posts de foto/carrusel (eso es solo de
// video) — se usa "reach" (cuentas únicas alcanzadas) como el denominador de
// exposición, que es el rol que insights.js espera en metrics.views para
// calcular tasas de engagement/guardado/compartido.
function mapGraphMetricsToSchema(dataArray) {
  const byName = {};
  (dataArray || []).forEach(m => { byName[m.name] = m.values?.[0]?.value ?? null; });
  return {
    views:    byName.reach ?? null,
    likes:    byName.likes ?? null,
    comments: byName.comments ?? null,
    shares:   byName.shares ?? null,
    saves:    byName.saved ?? null,
  };
}

async function fetchOneMediaInsights(postId) {
  const url = `https://graph.facebook.com/v21.0/${postId}/insights?metric=${METRICS_QUERY}&access_token=${config.metaAccessToken}`;
  const res = await httpGet(url);
  if (res.error) throw new Error(`${res.error.message} (code ${res.error.code})`);
  return mapGraphMetricsToSchema(res.data);
}

function isEligible(post) {
  if (post.platform !== 'instagram') return false;   // TikTok: ver nota arriba, siempre manual
  if ((post.status || 'published') !== 'published') return false;
  if (!post.post_id) return false;
  if (post.metrics && post.metrics.views != null) return false; // ya tiene métricas
  const ageHours = (Date.now() - new Date(post.published_at).getTime()) / 3600000;
  return ageHours >= MIN_AGE_HOURS;
}

async function fetchAndUpdate() {
  if (!config.metaAccessToken) {
    console.log('[insights-fetch] metaAccessToken no configurado — saltando');
    return { actualizados: 0, fallidos: 0 };
  }

  const hist = history.load();
  const pendientes = hist.posts.filter(isEligible);

  if (pendientes.length === 0) {
    console.log('[insights-fetch] Sin posts de Instagram elegibles (todos con métricas, o menos de 24h).');
    return { actualizados: 0, fallidos: 0 };
  }

  console.log(`[insights-fetch] ${pendientes.length} post(s) de Instagram sin métricas y con +${MIN_AGE_HOURS}h de antigüedad`);

  let actualizados = 0, fallidos = 0;
  for (const post of pendientes) {
    try {
      const metrics = await fetchOneMediaInsights(post.post_id);
      post.metrics = metrics;
      console.log(`  ✓ ${post.post_id} (${post.tema?.slice(0, 40)}...) → reach ${metrics.views ?? '—'}, likes ${metrics.likes ?? '—'}, saves ${metrics.saves ?? '—'}`);
      actualizados++;
    } catch (e) {
      // No tirar el ciclo completo por esto — falta de permiso o token vencido
      // no debe bloquear research/generate/publish del día.
      console.warn(`  ⚠ ${post.post_id}: ${e.message}`);
      fallidos++;
    }
  }

  if (actualizados > 0) {
    history.save(hist);
    console.log(`[insights-fetch] ✅ ${actualizados} post(s) actualizados en post_history.json`);
  }
  if (fallidos > 0) {
    console.log(`[insights-fetch] ⚠ ${fallidos} post(s) fallaron — revisa el scope instagram_manage_insights del token (ver comentario al inicio del archivo).`);
  }
  return { actualizados, fallidos };
}

if (require.main === module) {
  fetchAndUpdate().catch(e => { console.error('[insights-fetch] Error:', e.message); process.exit(1); });
}

module.exports = { fetchAndUpdate };
