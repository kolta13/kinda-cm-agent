# ── Kinda CM Agent — Configurar Windows Task Scheduler ──────────────────
# Registra una tarea programada que ejecuta el agente cada lunes a las 09:00.
#
# Ejecución (como Administrador):
#   powershell -ExecutionPolicy Bypass -File setup-task-scheduler.ps1

$TaskName    = "KindaCMAgent"
$NodePath    = (Get-Command node -ErrorAction Stop).Source
$ScriptPath  = "C:\Proyectos Claude Code\cm-agent\agent.js"
$LogPath     = "C:\Proyectos Claude Code\cm-agent\data\agent-scheduler.log"
$WorkDir     = "C:\Proyectos Claude Code\cm-agent"

# Crear el directorio de datos si no existe
New-Item -ItemType Directory -Force -Path "$WorkDir\data" | Out-Null

# Definir la acción: node agent.js, con stdout/stderr al log
$Action = New-ScheduledTaskAction `
  -Execute  $NodePath `
  -Argument "`"$ScriptPath`"" `
  -WorkingDirectory $WorkDir

# Trigger: todos los días a las 09:00
$Trigger = New-ScheduledTaskTrigger `
  -Daily `
  -At "19:00"

# Configuración: ejecutar aunque no haya sesión abierta, reintentar si falla
$Settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -RestartCount 1 `
  -RestartInterval (New-TimeSpan -Minutes 30) `
  -StartWhenAvailable `
  -RunOnlyIfNetworkAvailable

# Principal: ejecutar como el usuario actual
$Principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType S4U `
  -RunLevel Highest

# Registrar (o actualizar si ya existe)
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Set-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal
  Write-Host "[OK] Tarea '$TaskName' actualizada."
} else {
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal
  Write-Host "[OK] Tarea '$TaskName' registrada."
}

Write-Host ""
Write-Host "Configuración:"
Write-Host "  Ejecuta:  node `"$ScriptPath`""
Write-Host "  Horario:  Todos los días a las 19:00"
Write-Host "  Log:      $WorkDir\data\agent.log"
Write-Host ""
Write-Host "Comandos útiles:"
Write-Host "  Ver tarea:     Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Correr ahora:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Eliminar:      Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
