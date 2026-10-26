$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
$url = 'http://127.0.0.1:4310'

if (-not (Test-Path -LiteralPath $node)) { throw 'Runtime Node.js absent. Reextrais toute l archive ZIP.' }
$portProbe = New-Object System.Net.Sockets.TcpClient
try {
  $connect = $portProbe.BeginConnect('127.0.0.1', 4310, $null, $null)
  if ($connect.AsyncWaitHandle.WaitOne(400)) {
    try { $portProbe.EndConnect($connect) } catch {}
    if ($portProbe.Connected) { throw 'Le port local 4310 est déjà occupé. Ferme le serveur existant avant de relancer Docker Tracer.' }
  }
} finally { $portProbe.Dispose() }

$randomBytes = New-Object byte[] 32
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
$accessToken = [System.BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()

$dataDir = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Force $dataDir | Out-Null
$stdout = Join-Path $dataDir 'server.log'
$stderr = Join-Path $dataDir 'server-error.log'
$server = $null
$env:DTR_LOCAL_BOOTSTRAP_TOKEN = $accessToken
try {
  $server = Start-Process -FilePath $node -ArgumentList @('server/index.mjs', '--production') `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
} finally {
  Remove-Item Env:DTR_LOCAL_BOOTSTRAP_TOKEN -ErrorAction SilentlyContinue
}

try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($server.HasExited) { break }
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1
      if ($response.StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch {}
  }
  if (-not $ready) {
    throw "Docker Tracer ne demarre pas. Consulte $stderr. Si le port 4310 est utilise, ferme l application qui l occupe."
  }
  Set-Content -LiteralPath (Join-Path $dataDir 'server.pid') -Value $server.Id -NoNewline
  Start-Process "$url/?access=$accessToken"
  Write-Host "Docker Tracer est ouvert : $url"
  Write-Host 'Pour le fermer, lance Fermer-Docker-Tracer.cmd.'
  Write-Host "Les journaux et projets locaux sont dans : $dataDir"
} catch {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
  $pidFile = Join-Path $dataDir 'server.pid'
  if (Test-Path -LiteralPath $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force
  }
  throw
}
