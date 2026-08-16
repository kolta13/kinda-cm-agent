# Deploy Kinda CM Agent → kindagrowth.cl/cm-agent/
# Uso: powershell -File deploy.ps1
# NO sube: config.php (contiene keys), data/ (logs locales)

$ErrorActionPreference = 'Stop'
$ftpHost = 's440.v2nets.com'
$ftpUser = 'asistente@kindagrowth.cl'
$ftpPass = '6zFyXVeBLKsN~qRI'
$ftpBase = 'ftp://s440.v2nets.com'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Archivos a subir (config.php se sube manualmente la primera vez)
$files = @(
    'research.php',
    'generate.php',   # Fase 2 (aún no existe)
    'render.php',     # Fase 3 (aún no existe)
    'publish.php',    # Fase 4 (aún no existe)
    'agent.php',      # Fase 5 (aún no existe)
    '.htaccess'
)

# Crear carpeta cm-agent en el servidor (si no existe)
Write-Host "Creando directorio cm-agent..." -NoNewline
& curl.exe -s --ssl-reqd -u "${ftpUser}:${ftpPass}" --ftp-create-dirs `
    -T /dev/null "$ftpBase/cm-agent/" 2>$null
Write-Host " OK"

# Crear directorio data/ con su .htaccess
Write-Host "Creando data/.htaccess..." -NoNewline
& curl.exe -s --ssl-reqd -u "${ftpUser}:${ftpPass}" --ftp-create-dirs `
    -T "$dir\data\.htaccess" "$ftpBase/cm-agent/data/.htaccess"
Write-Host " OK"

foreach ($f in $files) {
    $local = Join-Path $dir $f
    if (-not (Test-Path $local)) { Write-Host "SALTADO (no existe aún): $f"; continue }
    Write-Host "Subiendo $f..." -NoNewline
    & curl.exe -s --ssl-reqd -u "${ftpUser}:${ftpPass}" -T $local "$ftpBase/cm-agent/$f"
    if ($LASTEXITCODE -ne 0) { Write-Host " ERROR"; exit 1 }
    Write-Host " OK"
}

Write-Host ""
Write-Host "Verificando https://kindagrowth.cl/cm-agent/research.php ..."
$code = & curl.exe -s -o NUL -w "%{http_code}" "https://kindagrowth.cl/cm-agent/research.php"
Write-Host "HTTP $code $(if ($code -eq '403') { '- OK (bloqueado sin key, correcto)' } elseif ($code -eq '200') { '- OK' } else { '- REVISAR' })"
