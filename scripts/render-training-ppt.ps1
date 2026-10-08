param(
  [Parameter(Mandatory = $true)][string]$Presentation,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$resolvedPresentation = (Resolve-Path -LiteralPath $Presentation).Path
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$trainingRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\runs\internal-training'))
if (-not $resolvedOutput.StartsWith($trainingRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The render directory must be inside runs/internal-training.'
}
if (Test-Path -LiteralPath $resolvedOutput) {
  throw 'The render directory already exists; previous images must be preserved.'
}
New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
$existingPowerPoint = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$application = New-Object -ComObject PowerPoint.Application
$deck = $null
try {
  # Read-only, without an interactive presentation window.
  $deck = $application.Presentations.Open($resolvedPresentation, -1, 0, 0)
  $deck.Export($resolvedOutput, 'PNG', 1600, 900)
  [pscustomobject]@{presentation = $resolvedPresentation; slides = $deck.Slides.Count; renderer = 'Microsoft PowerPoint'; output = $resolvedOutput} | ConvertTo-Json
} finally {
  if ($null -ne $deck) { $deck.Close(); [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($deck) }
  if (-not $existingPowerPoint) { $application.Quit() }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($application)
}
