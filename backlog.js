// ── Kinda CM Agent — Backlog de ideas ───────────────────────────────────
// Gestiona el pool persistente de ideas de contenido.
// Cada idea tiene: id, título, fuente, topic_tag, score, status.
//
// status: 'pending' | 'published' | 'skipped'

'use strict';
const fs   = require('fs');
const path = require('path');

const BACKLOG_PATH = path.join(__dirname, 'data', 'backlog.json');

// ── Taxonomía de temas ────────────────────────────────────────────────────
// Se usa para evitar repetir el mismo tema en días consecutivos.

const TOPIC_KEYWORDS = {
  monetizacion:  ['royalt', 'monetiz', 'gana', 'ingresos', 'sync', 'licenci', 'cobrar', 'dinero de', 'cuánto'],
  distribucion:  ['spotify', 'playlist', 'distrib', 'distrokid', 'tunecore', 'lanzamiento', 'lanzar', 'plataform'],
  marketing:     ['marketing', 'fanbase', 'branding', 'seguidores', 'engagement', 'redes', 'comunidad', 'crecer'],
  video_viral:   ['tiktok', 'youtube', 'video', 'viral', 'shorts', 'reels', 'algoritmo'],
  shows:         ['concierto', 'show', 'booking', 'gira', 'evento', 'merch', 'festival', 'presentaci'],
  networking:    ['contrat', 'sello', 'manager', 'colabo', 'networking', 'negoci', 'agenci', 'label'],
  tecnologia:    ['ia ', ' ia,', 'inteligencia artificial', 'producción', 'herramienta', 'daw', 'software', 'plugin', 'stem'],
  noticias:      ['noticia', 'tendencia', 'lanzó', 'anunci', 'nueva ley', 'industria musical', 'acuerdo'],
};

function detectTopic(title, description = '') {
  const text = (title + ' ' + description).toLowerCase();
  for (const [tag, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) return tag;
  }
  return 'general';
}

// Hash determinístico del título normalizado → ID estable
function ideaId(title) {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-záéíóúüñ0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  let h = 5381;
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h) + normalized.charCodeAt(i);
    h = h & h; // mantener 32-bit
  }
  return Math.abs(h).toString(36);
}

// ── CRUD del backlog ──────────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(BACKLOG_PATH)) return { updated_at: new Date().toISOString(), ideas: [] };
  return JSON.parse(fs.readFileSync(BACKLOG_PATH, 'utf8'));
}

function save(backlog) {
  backlog.updated_at = new Date().toISOString();
  const dir = path.dirname(BACKLOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BACKLOG_PATH, JSON.stringify(backlog, null, 2), 'utf8');
}

// Añadir ideas nuevas al backlog (ignora duplicados por ID)
function addIdeas(newIdeas) {
  const backlog    = load();
  const existingIds = new Set(backlog.ideas.map(i => i.id));
  let added = 0;

  for (const idea of newIdeas) {
    if (!idea.title || idea.title.length < 5) continue;
    const id = ideaId(idea.title);
    if (existingIds.has(id)) continue;
    existingIds.add(id);
    backlog.ideas.push({
      id,
      title:        idea.title,
      description:  idea.description || '',
      source:       idea.source || 'unknown',
      source_url:   idea.url    || '',
      topic_tag:    idea.topic_tag || detectTopic(idea.title, idea.description),
      score_total:  null,
      scores:       null,
      angulo:       null,
      por_que:      null,
      status:       'pending',
      discovered_at: new Date().toISOString(),
      published_at: null,
      post_id:      null,
    });
    added++;
  }

  save(backlog);
  return added;
}

// Tags de temas publicados en los últimos N días
function getRecentTopics(days = 5) {
  const backlog = load();
  const cutoff  = new Date(Date.now() - days * 86400000).toISOString();
  return new Set(
    backlog.ideas
      .filter(i => i.status === 'published' && i.published_at && i.published_at > cutoff)
      .map(i => i.topic_tag)
  );
}

// Ideas pendientes, opcionalmente excluyendo topics recientes
function getPendingIdeas(excludeTopics = new Set()) {
  const backlog = load();
  const pending = backlog.ideas.filter(i => i.status === 'pending');

  // Si quedan menos de 5 ideas con topics no recientes, ignorar restricción
  const filtered = pending.filter(i => !excludeTopics.has(i.topic_tag));
  return filtered.length >= 3 ? filtered : pending;
}

// Actualizar scores en el backlog (llamado desde generate.js después de scoring)
function updateScores(scores) {
  const backlog = load();
  for (const s of scores) {
    const id   = ideaId(s.title);
    const idea = backlog.ideas.find(i => i.id === id);
    if (idea) {
      idea.score_total   = s.score_total;
      idea.scores        = s.scores;
      idea.angulo        = s.angulo;
      idea.por_que       = s.por_que;
      idea.audience_type = s.audience_type || idea.audience_type || 'artista';
    }
  }
  save(backlog);
}

// Marcar una idea como publicada
function markPublished(id, postId) {
  const backlog = load();
  const idea    = backlog.ideas.find(i => i.id === id);
  if (idea) {
    idea.status       = 'published';
    idea.published_at = new Date().toISOString();
    idea.post_id      = postId;
  }
  save(backlog);
  return !!idea;
}

// Estadísticas del backlog (para logs)
function stats() {
  const backlog = load();
  const pending   = backlog.ideas.filter(i => i.status === 'pending').length;
  const published = backlog.ideas.filter(i => i.status === 'published').length;
  return { total: backlog.ideas.length, pending, published };
}

module.exports = { addIdeas, getPendingIdeas, getRecentTopics, updateScores, markPublished, ideaId, detectTopic, stats, load };
