$ErrorActionPreference = 'Stop'

$source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputs = Join-Path $source 'release'
$version = '0.12.1'
$nodeVersion = '24.14.0'
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeSha256 = '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66'
$name = "Docker-Tracer-$version-Windows-x64"
$stageRoot = Join-Path $PSScriptRoot ("stage-" + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$package = Join-Path $stageRoot $name
$nodeArchive = Join-Path $stageRoot $nodeArchiveName
$nodeExtract = Join-Path $stageRoot 'node-extract'

if (-not (Test-Path -LiteralPath (Join-Path $source 'dist\index.html'))) {
  throw 'Interface locale absente. Execute npm ci puis npm run build a la racine du depot.'
}

New-Item -ItemType Directory -Force $stageRoot, $package, $outputs | Out-Null
foreach ($directory in @('server', 'shared', 'dist')) {
  Copy-Item -LiteralPath (Join-Path $source $directory) -Destination $package -Recurse
}
Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $package
Copy-Item -LiteralPath (Join-Path $source 'package-lock.json') -Destination $package
Copy-Item -LiteralPath (Join-Path $source 'VERIFICATION.md') -Destination $package
Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination $package
New-Item -ItemType Directory -Force (Join-Path $package 'notices\brands') | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'src\assets\brands\sources.json') -Destination (Join-Path $package 'notices\brands')
Get-ChildItem -LiteralPath (Join-Path $source 'src\assets\brands') -Filter 'LICENSE-*.txt' -File |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $package 'notices\brands') }

Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName" -OutFile $nodeArchive -UseBasicParsing
$actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeArchive).Hash.ToLowerInvariant()
if ($actualSha256 -ne $nodeSha256) { throw "Node.js SHA256 incorrect : $actualSha256" }
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
New-Item -ItemType Directory -Force (Join-Path $package 'runtime') | Out-Null
$nodeFolder = Join-Path $nodeExtract "node-v$nodeVersion-win-x64"
Copy-Item -LiteralPath (Join-Path $nodeFolder 'node.exe') -Destination (Join-Path $package 'runtime')
Copy-Item -LiteralPath (Join-Path $nodeFolder 'LICENSE') -Destination (Join-Path $package 'runtime\NODE-LICENSE.txt')

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Docker-Tracer.cmd') -Destination $package
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Lancer-Docker-Tracer.ps1') -Destination $package
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Fermer-Docker-Tracer.cmd') -Destination $package
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Fermer-Docker-Tracer.ps1') -Destination $package
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LIRE-AVANT-DE-LANCER.txt') -Destination $package
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $package
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD_PARTY_NOTICES.txt') -Destination $package

Push-Location $package
try {
  & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Installation des dépendances de production impossible.' }
} finally { Pop-Location }

# ssh2 publie des clés privées de démonstration dans ses fixtures de test.
# Elles ne servent pas au runtime et ne doivent pas être distribuées.
$fixtures = Join-Path $package 'node_modules\ssh2\test'
if (Test-Path -LiteralPath $fixtures) {
  $resolvedFixtures = (Resolve-Path -LiteralPath $fixtures).Path
  $packagePrefix = [IO.Path]::GetFullPath($package).TrimEnd('\') + '\'
  if (-not $resolvedFixtures.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Chemin fixtures hors paquet : $resolvedFixtures"
  }
  Remove-Item -LiteralPath $resolvedFixtures -Recurse -Force
}

$archive = Join-Path $outputs "$name.zip"
$stagedArchive = Join-Path $stageRoot "$name.zip"
Compress-Archive -LiteralPath $package -DestinationPath $stagedArchive -CompressionLevel Optimal
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedArchive).Hash.ToLowerInvariant()
if (Test-Path -LiteralPath $archive) {
  [IO.File]::Replace($stagedArchive, $archive, (Join-Path $stageRoot 'previous-package.zip'))
} else {
  Move-Item -LiteralPath $stagedArchive -Destination $archive
}
Set-Content -LiteralPath (Join-Path $outputs "$name.sha256") -Value "$hash  $name.zip" -Encoding ascii
Write-Host "Archive: $archive"
Write-Host "SHA256: $hash"
Write-Host "Taille: $((Get-Item -LiteralPath $archive).Length) octets"
Write-Host "Stage: $package"
