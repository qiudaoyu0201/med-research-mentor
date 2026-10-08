# This launcher explicitly uses the already configured local Codex relay.
# It does not copy credentials, modify Codex config, or fall back to another model.
param(
  [ValidatePattern('^[A-Za-z0-9_-]+$')]
  [string]$Provider = 'klapi',
  [ValidateNotNullOrEmpty()]
  [string]$Model = 'gpt-5.6-sol',
  [ValidateSet('apiKey')]
  [string]$Auth = 'apiKey',
  [switch]$Production,
  [switch]$InspectOnly
)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) {
  $taskNode = (Get-Command node.exe -ErrorAction Stop).Source
}
$taskVersion = (& $taskNode -p 'process.versions.node').Trim()
if ([version]$taskVersion -lt [version]'22.13.0') {
  throw 'Node.js 22.13 or newer is required. Install it before starting the tutor.'
}
$taskEnvironment = @{}
foreach ($taskName in @('Path', 'TUTOR_PROVIDER', 'TUTOR_MODEL', 'TUTOR_CODEX_PROVIDER', 'TUTOR_CODEX_AUTH')) {
  $taskEnvironment[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process')
}
Push-Location $taskRoot
try {
  $env:Path = (Split-Path -Parent $taskNode) + ';' + $env:Path
  $env:TUTOR_PROVIDER = 'codex-configured'
  $env:TUTOR_MODEL = $Model
  $env:TUTOR_CODEX_PROVIDER = $Provider
  $env:TUTOR_CODEX_AUTH = $Auth
  Write-Host "Selected provider=$Provider model=$Model auth=$Auth. No automatic fallback."
  Write-Host 'Checking the existing Codex configuration (no model generation)...'
  & $taskNode --import tsx scripts/model-check.ts --require-auth
  if ($LASTEXITCODE -ne 0) { throw 'Configuration check failed. The server was not started.' }
  if (-not $InspectOnly) {
    if ($Production) {
      if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist\index.html'))) {
        throw 'Production build is missing. Run npm run build first.'
      }
      & $taskNode --import tsx server/index.ts --production
    } else {
      & $taskNode --import tsx server/index.ts
    }
    if ($LASTEXITCODE -ne 0) { throw "Tutor server exited with code $LASTEXITCODE." }
  }
} finally {
  foreach ($taskName in $taskEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($taskName, $taskEnvironment[$taskName], 'Process')
  }
  Pop-Location
}
