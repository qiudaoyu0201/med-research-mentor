param(
  [Parameter(Mandatory = $true)][string]$DocxPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [switch]$CleanupOnly
)
$ErrorActionPreference = 'Stop'
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$ownerPath = Join-Path $resolvedOutput 'word-owned-process.json'
if ($CleanupOnly) {
  if (Test-Path -LiteralPath $ownerPath) {
    $owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
    $ownedProcess = Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue
    if ($ownedProcess -and $ownedProcess.ProcessName -eq 'WINWORD' -and
        $ownedProcess.Path -eq $owner.path -and
        $ownedProcess.StartTime.ToUniversalTime().ToString('o') -eq $owner.startedAt) {
      Stop-Process -Id $ownedProcess.Id
      Write-Output "Cleaned up owned Word process $($ownedProcess.Id)"
    }
  }
  exit 0
}
$resolvedDocx = (Resolve-Path -LiteralPath $DocxPath).Path
if (Get-Process -Name WINWORD -ErrorAction SilentlyContinue) {
  throw 'Microsoft Word is already running. Close the existing Word session before this isolated verification.'
}
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
$pdfPath = Join-Path $resolvedOutput 'full-plan-fixture.pdf'
$wordReportPath = Join-Path $resolvedOutput 'word-open-report.json'
$tracePath = Join-Path $resolvedOutput 'word-render-trace.txt'
Set-Content -LiteralPath $tracePath -Value 'Creating hidden Word instance' -Encoding UTF8
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $ownedProcesses = @(Get-Process -Name WINWORD -ErrorAction Stop)
  if ($ownedProcesses.Count -ne 1) { throw 'Cannot identify the isolated Word process safely.' }
  $ownedProcess = $ownedProcesses[0]
  @{ pid=$ownedProcess.Id; processName=$ownedProcess.ProcessName; path=$ownedProcess.Path; startedAt=$ownedProcess.StartTime.ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $ownerPath -Encoding UTF8
  Add-Content -LiteralPath $tracePath -Value 'Word COM object created'
  $word.Visible = $false
  $word.DisplayAlerts = 0
  Add-Content -LiteralPath $tracePath -Value 'Opening read-only document'
  $document = $word.Documents.Open($resolvedDocx, $false, $true, $false)
  Add-Content -LiteralPath $tracePath -Value 'Document opened'
  Add-Content -LiteralPath $tracePath -Value 'Exporting PDF with Word pagination'
  $document.ExportAsFixedFormat($pdfPath, 17, $false)
  Add-Content -LiteralPath $tracePath -Value 'PDF exported'
  $pageCount = [int]$document.ComputeStatistics(2)
  Add-Content -LiteralPath $tracePath -Value "Page count computed: $pageCount"
  $report = [ordered]@{
    renderer = 'Microsoft Word COM'
    wordVersion = [string]$word.Version
    openedReadOnly = [bool]$document.ReadOnly
    hidden = -not [bool]$word.Visible
    pages = $pageCount
    tables = [int]$document.Tables.Count
    hyperlinks = [int]$document.Hyperlinks.Count
    source = $resolvedDocx
    pdf = $pdfPath
    text = [string]$document.Content.Text
    modelCalls = 0
  }
  Add-Content -LiteralPath $tracePath -Value 'Document properties collected'
  if (-not (Test-Path -LiteralPath $pdfPath)) { throw 'Word PDF export did not produce an output file.' }
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $wordReportPath -Encoding UTF8
  $report.Remove('text')
  $report | ConvertTo-Json -Depth 5
} finally {
  $dontSave = 0
  if ($null -ne $document) {
    $document.Close([ref]$dontSave)
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
  }
  if ($null -ne $word) {
    $word.Quit([ref]$dontSave)
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
