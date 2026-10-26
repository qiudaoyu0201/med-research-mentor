param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$sourcePath = (Resolve-Path -LiteralPath $InputPath).Path
$renderDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $renderDirectory | Out-Null
$existingPowerPoint = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$application = $null
$presentation = $null
try {
  $application = New-Object -ComObject PowerPoint.Application
  $presentation = $application.Presentations.Open($sourcePath, -1, 0, 0)
  $pages = @()
  for ($pageIndex = 1; $pageIndex -le $presentation.Slides.Count; $pageIndex++) {
    $pagePath = Join-Path $renderDirectory ('slide-{0:D2}.png' -f $pageIndex)
    $presentation.Slides.Item($pageIndex).Export($pagePath, 'PNG', 1600, 900)
    $pages += $pagePath
  }
  @{ renderer = 'powerpoint'; pageCount = $pages.Count; pages = $pages } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $presentation) {
    $presentation.Close()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) | Out-Null
  }
  if ($null -ne $application) {
    if (-not $existingPowerPoint -and $application.Presentations.Count -eq 0) { $application.Quit() }
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($application) | Out-Null
  }
}
