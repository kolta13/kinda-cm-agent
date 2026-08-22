// ── Kinda CM Agent — Archivo histórico de posts publicados ──────────────
// Guarda una copia permanente y consultable de cada carrusel publicado
// (texto completo de slides, caption, URLs de imagen, scores) para poder
// hacer retrospectivas y mejorar el sistema con el tiempo, sin depender
// de archivos efímeros (carousel_latest.json se sobreescribe cada día).
//
// data/post_history.json persiste en git (igual que backlog.json).

'use strict';
const fs   = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, 'data', 'post_history.json');

function load() {
  if (!fs.existsSync(HISTORY_PATH)) return { updated_at: new Date().toISOString(), posts: [] };
  return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
}

function save(history) {
  history.updated_at = new Date().toISOString();
  const dir = path.dirname(HISTORY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
}

// Registra un post recién publicado. `platform`: 'instagram' | 'tiktok'.
function appendPost({ platform, week, tema, topic_tag, audience_type, backlog_id, winner_score, post_id, caption, hashtags, slides, image_urls }) {
  const history = load();
  history.posts.push({
    platform:      platform || 'instagram',
    published_at:  new Date().toISOString(),
    week,
    tema,
    topic_tag:     topic_tag || null,
    audience_type: audience_type || null,
    backlog_id:    backlog_id || null,
    winner_score:  winner_score ?? null,
    post_id,
    caption:       caption || '',
    hashtags:      hashtags || [],
    slides:        (slides || []).map(s => ({ tipo: s.tipo, titulo: s.titulo, body: s.body || null })),
    image_urls:    image_urls || [],
    // Espacio para métricas de engagement, si en el futuro se consultan via Graph API insights
    metrics:       null,
  });
  save(history);
  return history.posts.length;
}

function getAll() {
  return load().posts;
}

function getRecent(n = 10) {
  const posts = load().posts;
  return posts.slice(-n).reverse();
}

module.exports = { appendPost, getAll, getRecent };
