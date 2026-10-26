$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
$url = 'http://127.0.0.1:4310'
$dataDir = Join-Path $PSScriptRoot 'data'
$pidFile = Join-Path $dataDir 'server.pid'
$reopenFile = Join-Path $dataDir 'server.reopen'
function Open-DockerTracer([string]$token) {
  if ($env:DTR_NO_OPEN_BROWSER -eq '1') {
    Write-Host "Ouvrez Docker Tracer : $url/?access=$token"
  } else {
    Start-Process "$url/?access=$token"
    Write-Host "Docker Tracer est ouvert : $url"
  }
}

if (-not (Test-Path -LiteralPath $node)) { throw 'Runtime Node.js absent. Reextrais toute l archive ZIP.' }
$portProbe = New-Object System.Net.Sockets.TcpClient
try {
  $connect = $portProbe.BeginConnect('127.0.0.1', 4310, $null, $null)
  if ($connect.AsyncWaitHandle.WaitOne(400)) {
    try { $portProbe.EndConnect($connect) } catch {}
    if ($portProbe.Connected) {
      if (-not (Test-Path -LiteralPath $pidFile) -or -not (Test-Path -LiteralPath $reopenFile)) {
        throw 'Le port local 4310 est déjà occupé par un serveur non identifié.'
      }
      $serverId = [int](Get-Content -LiteralPath $pidFile -Raw)
      $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $serverId"
      $expectedNode = (Resolve-Path -LiteralPath $node).Path
      if (-not $process -or
          -not [string]::Equals($process.ExecutablePath, $expectedNode, [System.StringComparison]::OrdinalIgnoreCase) -or
          $process.CommandLine -notmatch 'server[/\\]index\.mjs') {
        throw 'Le port local 4310 est déjà occupé par un autre processus.'
      }
      $protected = [Convert]::FromBase64String((Get-Content -LiteralPath $reopenFile -Raw))
      $reopenToken = [Text.Encoding]::UTF8.GetString(
        [Security.Cryptography.ProtectedData]::Unprotect(
          $protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
      )
      if ($reopenToken -notmatch '^[a-f0-9]{64}$') { throw 'Jeton du lanceur invalide.' }
      $response = Invoke-RestMethod -Method Post -Uri "$url/_dtr/launcher/reopen" `
        -Headers @{ 'X-Docker-Tracer-Launcher' = $reopenToken } -TimeoutSec 3
      if ($response.bootstrapToken -notmatch '^[a-f0-9]{64}$') { throw 'Réponse du serveur invalide.' }
      Open-DockerTracer $response.bootstrapToken
      return
    }
  }
} finally { $portProbe.Dispose() }

$randomBytes = New-Object byte[] 32
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
try {
  $rng.GetBytes($randomBytes)
  $accessToken = [System.BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()
  $rng.GetBytes($randomBytes)
  $reopenToken = [System.BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()
} finally { $rng.Dispose() }

New-Item -ItemType Directory -Force $dataDir | Out-Null
$protected = [Security.Cryptography.ProtectedData]::Protect(
  [Text.Encoding]::UTF8.GetBytes($reopenToken), $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[IO.File]::WriteAllText($reopenFile, [Convert]::ToBase64String($protected))
$stdout = Join-Path $dataDir 'server.log'
$stderr = Join-Path $dataDir 'server-error.log'
$server = $null
$previousPort = $env:PORT
$env:PORT = '4310'
$env:DTR_LOCAL_BOOTSTRAP_TOKEN = $accessToken
$env:DTR_LOCAL_REOPEN_TOKEN = $reopenToken
try {
  $server = Start-Process -FilePath $node -ArgumentList @('server/index.mjs', '--production') `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
} catch {
  Remove-Item -LiteralPath $reopenFile -Force -ErrorAction SilentlyContinue
  throw
} finally {
  Remove-Item Env:DTR_LOCAL_BOOTSTRAP_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:DTR_LOCAL_REOPEN_TOKEN -ErrorAction SilentlyContinue
  if ($null -eq $previousPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue }
  else { $env:PORT = $previousPort }
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
  Open-DockerTracer $accessToken
  Write-Host 'Pour le fermer, lance Fermer-Docker-Tracer.cmd.'
  Write-Host "Les journaux et projets locaux sont dans : $dataDir"
} catch {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force
  }
  Remove-Item -LiteralPath $reopenFile -Force -ErrorAction SilentlyContinue
  throw
}
