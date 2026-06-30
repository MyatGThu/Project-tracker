# ─────────────────────────────────────────────────────────────
# package-for-sale.ps1
# Builds a clean, buyer-ready ZIP for CodeCanyon / Gumroad.
# Excludes your personal config.js, the real wrangler.jsonc,
# git history, node_modules, and any dev artifacts.
#
# Run:  pwsh ./package-for-sale.ps1
# Out:  dist/poker-tracker-<version>.zip
# ─────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'
$root    = $PSScriptRoot
$version = '1.0.0'
$stage   = Join-Path $root '.pkg_stage'
$zipPath = Join-Path $root "poker-tracker-$version.zip"

# Top-level files the buyer needs (note: config.js is intentionally absent —
# buyers copy config.example.js → config.js themselves)
$topLevel = @(
  'index.html', 'app.js', 'settlement.js', 'settlement.test.js', 'style.css',
  'config.example.js', 'manifest.json', 'sw.js', 'package.json', 'package-lock.json',
  'README.md', 'LICENSE', 'PRIVACY.md', 'TERMS.md', '.gitignore',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'
)

# Fresh staging area
if (Test-Path $stage)   { Remove-Item $stage -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($f in $topLevel) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $stage $f) -Force }
  else { Write-Warning "Missing (skipped): $f" }
}

# Worker source — only the templated files, never wrangler.jsonc or node_modules
$workerSrc = Join-Path $stage 'worker\src'
New-Item -ItemType Directory -Force -Path $workerSrc | Out-Null
Copy-Item (Join-Path $root 'worker\src\index.js')           (Join-Path $stage 'worker\src\index.js')           -Force
Copy-Item (Join-Path $root 'worker\schema.sql')             (Join-Path $stage 'worker\schema.sql')             -Force
Copy-Item (Join-Path $root 'worker\seed.sql')               (Join-Path $stage 'worker\seed.sql')               -Force
Copy-Item (Join-Path $root 'worker\wrangler.example.jsonc') (Join-Path $stage 'worker\wrangler.example.jsonc') -Force
Copy-Item (Join-Path $root 'worker\package.json')           (Join-Path $stage 'worker\package.json')           -Force

# Safety check — never ship personal config
if (Test-Path (Join-Path $stage 'config.js'))        { throw 'config.js leaked into package!' }
if (Test-Path (Join-Path $stage 'worker\wrangler.jsonc')) { throw 'wrangler.jsonc leaked into package!' }

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -Force
Remove-Item $stage -Recurse -Force

Write-Host ""
Write-Host "✓ Buyer package built: $zipPath" -ForegroundColor Green
Write-Host "  Upload this ZIP to CodeCanyon / Gumroad."
