$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskCandidates = @((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
$taskNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($taskNodeCommand) { $taskCandidates += $taskNodeCommand.Source }
$taskNode = $null
foreach ($taskCandidate in $taskCandidates) {
    if (Test-Path -LiteralPath $taskCandidate) {
        $taskVersion = & $taskCandidate -p 'process.versions.node'
        if ([version]$taskVersion -ge [version]'22.13.0') { $taskNode = $taskCandidate; break }
    }
}
if (-not $taskNode) { throw '请先安装 Node.js 22.13 或更新版本，再运行本脚本。' }
$env:Path = (Split-Path -Parent $taskNode) + ';' + $env:Path
try {
    $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2
    if ($taskHealth.app -eq 'medical-research-tutor') {
        Write-Host '导师已在运行，浏览器访问 http://127.0.0.1:4317 即可。'
        exit 0
    }
} catch { }
if (-not (Test-Path -LiteralPath 'node_modules')) {
    Write-Host '正在安装锁定依赖…'
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重试。' }
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '构建失败，请查看上面的具体错误。' }
Write-Host '启动后访问 http://127.0.0.1:4317；按 Ctrl+C 退出。'
if (Test-Path -LiteralPath '.env') {
    & $taskNode --env-file=.env --import tsx server/index.ts --production
} else {
    & $taskNode --import tsx server/index.ts --production
}
