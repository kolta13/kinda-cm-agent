<?php
// ── Kinda CM Agent — Fase 1: Research ──────────────────────────────────
// Busca tendencias y preguntas frecuentes del rubro musical en LATAM.
// Fuentes: Google Custom Search + YouTube Data API v3
// Output:  JSON con ~20 ideas raw → data/research_latest.json
//
// Uso directo (test): https://kindagrowth.cl/cm-agent/research.php?key=TU_KEY
// Uso interno:        require_once 'research.php'; $ideas = kinda_research();

require_once __DIR__ . '/config.php';

// ── Protección de acceso directo ────────────────────────────────────────
if (php_sapi_name() !== 'cli') {
    $k = $_GET['key'] ?? '';
    if ($k !== AGENT_KEY) { http_response_code(403); die('Forbidden'); }
}

// ── Queries semilla ─────────────────────────────────────────────────────
// Qué busca un músico independiente en LATAM que quiere crecer.
// Se rotan en cada corrida para no repetir las mismas ideas cada semana.
const GOOGLE_QUERIES = [
    'cómo lanzar una canción en spotify 2025',
    'cómo crecer en spotify como artista independiente',
    'cómo conseguir playlists editoriales spotify',
    'marketing digital para músicos independientes',
    'cómo monetizar música en streaming',
    'distribución musical independiente latinoamérica',
    'cómo hacer crecer fanbase músico',
    'estrategia tiktok para artistas musicales',
    'cómo conseguir booking conciertos independiente',
    'errores comunes músicos independientes',
    'cómo negociar con un sello discográfico',
    'royalties streaming cuánto se gana',
    'sync licensing música para publicidad',
    'cómo hacer un videoclip bajo presupuesto',
    'productores musicales emergentes latinoamérica',
];

const YOUTUBE_QUERIES = [
    'músico independiente consejos 2025',
    'cómo vivir de la música sin sello',
    'marketing musical artista emergente',
    'spotify for artists estrategia',
    'cómo crecer en tiktok siendo músico',
];

// ── Helpers de API ───────────────────────────────────────────────────────

function http_get(string $url, int $timeout = 10): ?string {
    $ctx = stream_context_create(['http' => [
        'timeout' => $timeout,
        'header'  => "User-Agent: KindaCMAgent/1.0\r\n",
    ]]);
    $raw = @file_get_contents($url, false, $ctx);
    return $raw !== false ? $raw : null;
}

function search_google(string $query, int $limit = 5): array {
    if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_CSE_ID) return [];

    $url = 'https://www.googleapis.com/customsearch/v1?' . http_build_query([
        'key'          => GOOGLE_SEARCH_API_KEY,
        'cx'           => GOOGLE_CSE_ID,
        'q'            => $query,
        'num'          => $limit,
        'lr'           => 'lang_es',
        'gl'           => 'cl',
        'dateRestrict' => 'm6', // últimos 6 meses
    ]);

    $raw = http_get($url);
    if (!$raw) return [];

    $data  = json_decode($raw, true);
    $items = $data['items'] ?? [];

    $results = [];
    foreach ($items as $i) {
        $results[] = [
            'title'       => trim($i['title'] ?? ''),
            'description' => trim($i['snippet'] ?? ''),
            'url'         => $i['link'] ?? '',
            'source'      => 'google',
            'query'       => $query,
            'date'        => $i['pagemap']['metatags'][0]['article:published_time']
                             ?? ($i['pagemap']['newsarticle'][0]['datepublished'] ?? ''),
        ];
    }
    return $results;
}

function search_youtube(string $query, int $limit = 4): array {
    // Usa la misma API key de Google Cloud (habilitar YouTube Data API v3)
    if (!GOOGLE_SEARCH_API_KEY) return [];

    $url = 'https://www.googleapis.com/youtube/v3/search?' . http_build_query([
        'key'               => GOOGLE_SEARCH_API_KEY,
        'q'                 => $query,
        'part'              => 'snippet',
        'type'              => 'video',
        'maxResults'        => $limit,
        'order'             => 'viewCount',
        'relevanceLanguage' => 'es',
        'publishedAfter'    => gmdate('Y-m-d', strtotime('-6 months')) . 'T00:00:00Z',
    ]);

    $raw = http_get($url);
    if (!$raw) return [];

    $data  = json_decode($raw, true);
    $items = $data['items'] ?? [];

    $results = [];
    foreach ($items as $i) {
        $vid = $i['id']['videoId'] ?? '';
        if (!$vid) continue;
        $results[] = [
            'title'       => trim($i['snippet']['title'] ?? ''),
            'description' => trim($i['snippet']['description'] ?? ''),
            'url'         => "https://youtube.com/watch?v={$vid}",
            'source'      => 'youtube',
            'query'       => $query,
            'date'        => $i['snippet']['publishedAt'] ?? '',
        ];
    }
    return $results;
}

// ── Selección rotativa de queries ────────────────────────────────────────
// Cada semana usa un subconjunto distinto para no repetir ideas.
// La semana del año determina qué bloque de queries se usa.

function get_weekly_queries(array $pool, int $n): array {
    $week   = (int) date('W');
    $offset = ($week * $n) % count($pool);
    $slice  = array_slice($pool, $offset, $n);
    // Si se cortó al final del array, completar desde el inicio
    if (count($slice) < $n) {
        $slice = array_merge($slice, array_slice($pool, 0, $n - count($slice)));
    }
    return $slice;
}

// ── Deduplicación por similitud de título ───────────────────────────────

function normalize_title(string $t): string {
    $t = mb_strtolower($t);
    $t = preg_replace('/[^a-záéíóúüñ0-9\s]/u', '', $t);
    $t = preg_replace('/\s+/', ' ', trim($t));
    return substr($t, 0, 50);
}

// ── Función principal ────────────────────────────────────────────────────

function kinda_research(): array {
    $ideas = [];
    $seen  = [];

    // Google: 6 queries esta semana
    $gQueries = get_weekly_queries(GOOGLE_QUERIES, 6);
    foreach ($gQueries as $q) {
        foreach (search_google($q, 4) as $r) {
            if (!$r['title']) continue;
            $key = normalize_title($r['title']);
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $ideas[] = $r;
        }
        usleep(300000); // 300ms entre llamadas para no saturar la API
    }

    // YouTube: 3 queries esta semana
    $ytQueries = get_weekly_queries(YOUTUBE_QUERIES, 3);
    foreach ($ytQueries as $q) {
        foreach (search_youtube($q, 4) as $r) {
            if (!$r['title']) continue;
            $key = normalize_title($r['title']);
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $ideas[] = $r;
        }
        usleep(300000);
    }

    $output = [
        'generated_at' => date('Y-m-d H:i:s'),
        'week'         => (int) date('W'),
        'total'        => count($ideas),
        'ideas'        => $ideas,
    ];

    // Guardar para que generate.php lo lea sin volver a llamar las APIs
    $dataDir = __DIR__ . '/data';
    if (!is_dir($dataDir)) mkdir($dataDir, 0755, true);
    file_put_contents(
        "$dataDir/research_latest.json",
        json_encode($output, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
    );

    return $output;
}

// ── Ejecución directa (test vía browser o CLI) ───────────────────────────
if (basename(__FILE__) === basename($_SERVER['SCRIPT_FILENAME'] ?? '')) {
    $result = kinda_research();
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
