Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Push-Location (Split-Path -Parent $MyInvocation.MyCommand.Path) | Out-Null
Push-Location ..\  # repo root

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# Ensure LSP servers are available locally (no PATH assumptions)
Step "Installing local LSP servers (ts, ts-language-server, pyright)…"
npm i -D typescript typescript-language-server pyright --prefix packages/cli | Out-Null

Step "Building CLI…"
npm run build --prefix packages/cli | Out-Null

# Output dir
$diagDir = "WebApp\Diagram"
New-Item -ItemType Directory -Force -Path $diagDir | Out-Null

# Generate
$roots = @(".\core\src",".\editors\code\src",".\webview-ui\src",".\packages\cli\src")
$detailed = Join-Path $diagDir "detailedView.html"
$simplified = Join-Path $diagDir "simplifiedView.html"

Step "Generating detailed diagram…"
node .\packages\cli\dist\cli.js --roots $roots --out $detailed

Step "Generating simplified diagram…"
node .\packages\cli\dist\cli.js --roots $roots --out $simplified --simplified

# Checks
Step "Verifying outputs…"
$files = Get-Item $detailed, $simplified
$files | ForEach-Object {
  if ($_.Length -le 0) { throw "Empty output: $($_.FullName)" }
}

$hasSvg1 = (Select-String -Path $detailed -Pattern '<svg' -SimpleMatch -Quiet)
$hasSvg2 = (Select-String -Path $simplified -Pattern '<svg' -SimpleMatch -Quiet)
if (-not ($hasSvg1 -and $hasSvg2)) { throw "SVG marker not found in outputs." }

Write-Host "`n✅ Smoke test passed." -ForegroundColor Green
$files | Format-Table Name,Length,FullName

Pop-Location | Out-Null
Pop-Location | Out-Null
