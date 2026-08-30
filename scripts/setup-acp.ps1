# ==================== BuddyBridge Deep - DSH ACP backend one-click setup ====================
# Usage (run in buddybridge-deep dir, normal PowerShell/terminal):
#   powershell -ExecutionPolicy Bypass -File scripts/setup-acp.ps1
# Optional params (defaults match dsh 0.1.0-rc.7):
#   -Provider deepseek
#   -Model deepseek-v4-flash
# Idempotent: skips work already done.
# NOTE: File is PURE ASCII on purpose - Windows PowerShell 5.1 reads .ps1 as ANSI,
#       and UTF-8 Chinese comments break variable parsing. Keep it ASCII.

param(
    [string]$Provider = "deepseek",
    [string]$Model = "deepseek-v4-flash",
    [string]$DemoVersion = "0.1.0-rc.7"
)

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $dshHome "profiles\acp"
$cordisPath = Join-Path $profileDir "cordis.yml"

Write-Host "== BuddyBridge Deep ACP backend setup =="

# 1. dsh check
Write-Host "[1/4] checking dsh ..."
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) { Write-Host "[FAIL] dsh not found. Please install DeepSeek Harness first."; exit 1 }
Write-Host "      dsh: $($dsh.Source)"

# 2. pnpm check / install
Write-Host "[2/4] checking pnpm ..."
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Write-Host "      pnpm not found, installing globally via npm ..."
    npm install -g pnpm
    if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] pnpm install failed"; exit 1 }
}
Write-Host "      pnpm: $(& pnpm --version)"

# 3. add ACP demo to acp profile
Write-Host "[3/4] configuring acp profile ..."
$pkgJson = Join-Path $profileDir "package.json"
$needAdd = $true
if (Test-Path $pkgJson) {
    $content = Get-Content $pkgJson -Raw
    if ($content -match "dsh-acp-demo") { $needAdd = $false }
}
if ($needAdd) {
    dsh plugin --profile acp add "@deepseek-ai/dsh-acp-demo@$DemoVersion"
    if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] dsh plugin install failed (see error above)"; exit 1 }
} else {
    Write-Host "      demo already in profile, skipping"
}

# 3b. enable autoInstallPeers + allow koffi native build (pnpm 11 reads from pnpm-workspace.yaml)
$wsYaml = Join-Path $profileDir "pnpm-workspace.yaml"
$wsContent = if (Test-Path $wsYaml) { Get-Content $wsYaml -Raw } else { "" }
if ($wsContent -match "autoInstallPeers:\s*false") {
    $wsContent = $wsContent -replace "autoInstallPeers:\s*false", "autoInstallPeers: true"
    Write-Host "      enabled autoInstallPeers"
}
if ($wsContent -notmatch "koffi:\s*true") {
    $lines = $wsContent -split "`r?`n" | Where-Object {
        $_ -notmatch "^\s*onlyBuiltDependencies:" -and
        $_ -notmatch "^\s+-\s" -and
        $_ -notmatch "^\s*allowBuilds:" -and
        $_ -notmatch "^\s*koffi:"
    }
    $wsContent = ($lines -join "`n").TrimEnd() + "`n`nallowBuilds:`n  koffi: true`n"
    Write-Host "      allowed koffi build script (allowBuilds: koffi: true)"
}
[System.IO.File]::WriteAllText($wsYaml, $wsContent, $utf8NoBom)

# 3b2. normalize profile package.json: drop stale pnpm field, force UTF-8 without BOM
#      (BOM makes dsh's JSON.parse throw "Unexpected token '<feff>'")
$pkgObj = Get-Content $pkgJson -Raw | ConvertFrom-Json
if ($pkgObj.pnpm) {
    $pkgObj.PSObject.Properties.Remove("pnpm")
}
[System.IO.File]::WriteAllText($pkgJson, ($pkgObj | ConvertTo-Json -Depth 8), $utf8NoBom)
Write-Host "      normalized profile package.json (UTF-8, no BOM)"

# 3c. install (pulls peer deps + rebuilds koffi); ERR_PNPM_IGNORED_BUILDS alone is not fatal
Push-Location $profileDir
$installOut = & pnpm install 2>&1
$installExit = $LASTEXITCODE
Pop-Location
$outText = $installOut -join "`n"
if ($installExit -ne 0 -and -not ($outText -match "ERR_PNPM_IGNORED_BUILDS")) {
    Write-Host "[FAIL] pnpm install (peers) failed"; exit 1
}

# 4. generate cordis.yml (regenerate if it still has old relative ./.sessions)
Write-Host "[4/4] generating cordis.yml ..."
$sessionsRoot = Join-Path $profileDir ".sessions"
$cordisContent = @"
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    thinking: enabled
    models:
      - id: $Model
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    persona: >-
      You are a coding assistant powered by the {{model}} model. Your working directory is {{cwd}}.
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: !!js process.cwd()
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: !!js process.cwd()
- id: acp-demo
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: deepseek-official
    model: $Model
    persistenceRoot: $sessionsRoot
    workspaceContext: false
"@
$needWrite = $true
if (Test-Path $cordisPath) {
    $existing = Get-Content $cordisPath -Raw
    # if already a valid plugin tree (top-level array containing acp-demo) skip; old map format gets rewritten
    if ($existing.TrimStart().StartsWith("-") -and $existing -match "acp-demo") {
        Write-Host "      cordis.yml already a valid plugin tree, skipping"
        $needWrite = $false
    }
}
if ($needWrite) {
    [System.IO.File]::WriteAllText($cordisPath, $cordisContent, $utf8NoBom)
    Write-Host "      wrote plugin-tree cordis.yml (top-level array)"
}
Write-Host "      $cordisPath"

$demoBin = Join-Path $profileDir "node_modules\@deepseek-ai\dsh-acp-demo\lib\bin.js"
Write-Host ""
Write-Host "[OK] Setup complete!"
Write-Host ""
Write-Host "IMPORTANT: dsh --profile acp does NOT load the ACP server (demo is not a bundle)."
Write-Host "Use the standalone demo bin as the ACP command:"
Write-Host ""
Write-Host "  node $demoBin -c $cordisPath"
Write-Host ""
Write-Host "Smoke test:"
Write-Host "  node scripts/acp-smoke.mjs --command ""node $demoBin -c $cordisPath"" --cwd ""C:\your\vault"""
Write-Host ""
Write-Host "In Obsidian plugin settings, set 'DSH ACP command' to:"
Write-Host "  node $demoBin -c $cordisPath"
Write-Host ""
Write-Host "To change model: edit $cordisPath (available: deepseek-v4-flash / deepseek-v4-pro)"
