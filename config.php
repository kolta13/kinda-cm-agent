<?php
// ── Kinda CM Agent — Configuración ─────────────────────────────────────
// NUNCA subir a Git. Contiene todas las API keys del sistema.

// Clave de acceso interna (protege los endpoints de llamadas externas)
define('AGENT_KEY', 'CAMBIAR_POR_KEY_ALEATORIA');

// Google Cloud — habilitar: Custom Search API + YouTube Data API v3
// https://console.cloud.google.com → APIs → Credentials → Create API key
define('GOOGLE_SEARCH_API_KEY', '');
define('GOOGLE_CSE_ID',         ''); // https://cse.google.com/cse/create/new → buscar en toda la web

// Gemini (ya la tienes)
define('GEMINI_API_KEY', '');

// Meta Graph API (Fase 4)
define('META_ACCESS_TOKEN',    '');
define('META_IG_USER_ID',      ''); // ID numérico de la cuenta de Instagram Business

// TikTok Content API (Fase 4)
define('TIKTOK_ACCESS_TOKEN',  '');

// ScreenshotOne (Fase 3) — https://screenshotone.com → gratis 100/mes
define('SCREENSHOT_API_KEY',   '');

// URL base del agente (para construir las URLs de los slides renderizados)
define('AGENT_BASE_URL', 'https://kindagrowth.cl/cm-agent');
