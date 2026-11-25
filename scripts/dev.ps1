param([switch]$SkipBuild, [int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$runtimePython = Join-Path $projectRoot '.runtime/python/python.exe'
$venvPython = Join-Path $projectRoot '.venv/Scripts/python.exe'
if (Test-Path -LiteralPath $runtimePython) { $pythonCommand = $runtimePython }
elseif (Test-Path -LiteralPath $venvPython) { $pythonCommand = $venvPython }
else { $pythonCommand = 'python' }
if (-not $SkipBuild) {
    Push-Location -LiteralPath (Join-Path $projectRoot 'apps/web')
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed. Install dependencies as described in README.' }
    } finally { Pop-Location }
}
$env:PYTHONPATH = Join-Path $projectRoot 'apps/backend'
$env:PYTHONUTF8 = '1'
$workerProcess = $null
try {
    $workerProcess = Start-Process -FilePath $pythonCommand -ArgumentList '-m','drone_lab.worker' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    Write-Host "Workbench: http://127.0.0.1:$Port (Ctrl+C to stop; experiment state is persisted)"
    & $pythonCommand -m uvicorn drone_lab.api:app --host 127.0.0.1 --port $Port
} finally {
    if ($workerProcess -and -not $workerProcess.HasExited) { Stop-Process -Id $workerProcess.Id }
}
