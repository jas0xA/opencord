# Builds a self-contained Windows server zip: bundled JS + native modules + node.exe.
#   powershell -ExecutionPolicy Bypass -File scripts\package-server.ps1
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path "$PSScriptRoot\.."
$Version = node -p "require('$($Root -replace '\\','/')/packages/server/package.json').version"
$Name = "opencord-server-$Version-win-x64"
$Out = Join-Path $Root "release\$Name"

if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force $Out | Out-Null
Push-Location "$Root\packages\server"; node build.mjs | Out-Null; Pop-Location
Copy-Item "$Root\packages\server\dist\opencord-server.mjs" $Out
# The web app (for phones and browsers) is served by the server from .\web.
Push-Location "$Root\packages\client"; npx electron-vite build | Out-Null; Pop-Location
Copy-Item -Recurse "$Root\packages\client\out\renderer" "$Out\web"

$pkg = Get-Content "$Root\packages\server\package.json" | ConvertFrom-Json
$deps = @{ 'better-sqlite3' = $pkg.dependencies.'better-sqlite3'; '@node-rs/argon2' = $pkg.dependencies.'@node-rs/argon2' }
@{ name = 'opencord-server'; version = $Version; private = $true; type = 'module'; dependencies = $deps } | ConvertTo-Json | Set-Content "$Out\package.json"
Push-Location $Out; npm install --omit=dev --no-audit --no-fund --loglevel=error; Pop-Location

Copy-Item (Get-Command node).Source "$Out\node.exe"
Set-Content "$Out\opencord-server.cmd" "@echo off`r`n`"%~dp0node.exe`" `"%~dp0opencord-server.mjs`" %*"
Copy-Item "$Root\docs\self-hosting.md" "$Out\README.md"

Compress-Archive -Force -Path $Out -DestinationPath "$Root\release\$Name.zip"
Write-Host "Created release\$Name.zip"
