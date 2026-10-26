$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'data\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host 'Aucun serveur Docker Tracer lancé par ce paquet.'
  exit
}
$serverId = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $serverId"
$expectedNode = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\node.exe')).Path
if ($process -and
    [string]::Equals($process.ExecutablePath, $expectedNode, [System.StringComparison]::OrdinalIgnoreCase) -and
    $process.CommandLine -match 'server[/\\]index\.mjs') {
  Stop-Process -Id $serverId -ErrorAction Stop
  Write-Host 'Docker Tracer est fermé.'
} else {
  Write-Host 'Le serveur initial est déjà arrêté.'
}
Remove-Item -LiteralPath $pidFile -Force
Remove-Item -LiteralPath (Join-Path $PSScriptRoot 'data\server.reopen') -Force -ErrorAction SilentlyContinue
