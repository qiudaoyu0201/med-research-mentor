param([ValidateRange(1024, 65535)][int]$Port = 4319, [switch]$Resume)
$ErrorActionPreference = 'Stop'
$previewRoot = Split-Path -Parent $PSScriptRoot
$previewNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$previewDirectory = Join-Path $previewRoot "runs\live-preview-$Port"
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $Port is already in use; no process will be stopped."
}
if ((Test-Path -LiteralPath $previewDirectory) -and -not $Resume) {
  throw 'Preview directory already exists; preserve its data and inspect it before reuse.'
}
if (-not (Test-Path -LiteralPath (Join-Path $previewRoot 'dist\index.html'))) {
  throw 'Build the application before creating a preview.'
}
$previewState = Invoke-RestMethod 'http://127.0.0.1:4317/api/training-admission' -TimeoutSec 10
if ($previewState.busy -ne $false) { throw 'Wait for the online task before taking a data snapshot.' }
& (Join-Path $PSScriptRoot 'start-configured.ps1') -InspectOnly
if ($LASTEXITCODE -ne 0) { throw 'Model configuration check failed.' }
if ($Resume -and -not (Test-Path -LiteralPath (Join-Path $previewDirectory 'snapshot.json'))) {
  throw 'Resume requires an existing preview snapshot.'
}
if (-not $Resume) {
  New-Item -ItemType Directory -Path $previewDirectory | Out-Null
  foreach ($previewPart in @('server', 'shared', 'examples', 'materials', 'evals', 'skills', 'dist', 'data', 'exports', 'package.json')) {
    $previewSource = Join-Path $previewRoot $previewPart
    if (Test-Path -LiteralPath $previewSource) {
      Copy-Item -LiteralPath $previewSource -Destination $previewDirectory -Recurse
    }
  }
  $previewRevision = (& git -C $previewRoot rev-parse HEAD).Trim()
  @{ sourceRevision = $previewRevision; createdAt = (Get-Date).ToUniversalTime().ToString('o'); port = $Port; independentData = $true } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $previewDirectory 'snapshot.json') -Encoding utf8
}
$previewNames = @('PORT', 'TUTOR_DATA_DIR', 'TUTOR_PROVIDER', 'TUTOR_MODEL', 'TUTOR_CODEX_PROVIDER', 'TUTOR_CODEX_AUTH', 'TUTOR_READING_GUIDES')
$previewEnvironment = @{}
foreach ($previewName in $previewNames) {
  $previewEnvironment[$previewName] = [Environment]::GetEnvironmentVariable($previewName, 'Process')
}
try {
  $env:PORT = "$Port"
  $env:TUTOR_DATA_DIR = Join-Path $previewDirectory 'data'
  $env:TUTOR_PROVIDER = 'codex-configured'
  $env:TUTOR_MODEL = 'gpt-5.6-sol'
  $env:TUTOR_CODEX_PROVIDER = 'klapi'
  $env:TUTOR_CODEX_AUTH = 'apiKey'
  $env:TUTOR_READING_GUIDES = 'manual'
  $previewProcess = Start-Process -FilePath $previewNode -ArgumentList '--import','tsx','server/index.ts','--production' -WorkingDirectory $previewDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $previewDirectory 'stdout.log') -RedirectStandardError (Join-Path $previewDirectory 'stderr.log') -PassThru
  $previewReady = $false
  for ($previewTry = 0; $previewTry -lt 20; $previewTry++) {
    $previewProcess.Refresh()
    if ($previewProcess.HasExited) { throw "Preview exited; inspect $previewDirectory\stderr.log." }
    try {
      $previewHealth = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 1
      if ($previewHealth.app -eq 'medical-research-tutor') { $previewReady = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 250
  }
  if (-not $previewReady) { throw 'Preview started but health is not confirmed. Inspect it; do not launch a duplicate.' }
  @{ pid = $previewProcess.Id; url = "http://127.0.0.1:$Port/"; directory = $previewDirectory } | ConvertTo-Json
} finally {
  foreach ($previewName in $previewNames) {
    [Environment]::SetEnvironmentVariable($previewName, $previewEnvironment[$previewName], 'Process')
  }
}
