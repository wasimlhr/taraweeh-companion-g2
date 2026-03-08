# Deploy Whisper Quran Modal apps (int8, int4, onnx)
# Requires: pip install modal, then modal token new
# Usage:
#   .\scripts\deploy-modal.ps1           # deploy int8 + int4
#   .\scripts\deploy-modal.ps1 int8     # deploy int8 only
#   .\scripts\deploy-modal.ps1 int4     # deploy int4 only
#   .\scripts\deploy-modal.ps1 onnx     # deploy ONNX quantized only

param([string]$Target = "both")

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
if (-not $root) { $root = (Get-Location).Path }

function Deploy-ModalApp {
    param([string]$Name, [string]$Dir)
    $path = Join-Path $root $Dir
    if (-not (Test-Path $path)) {
        Write-Warning "Directory not found: $path"
        return
    }
    $appPy = Join-Path $path "app.py"
    if (-not (Test-Path $appPy)) {
        Write-Warning "app.py not found in $path"
        return
    }
    Write-Host "Deploying $Name from $Dir ..." -ForegroundColor Cyan
    Push-Location $path
    try {
        modal deploy app.py
        Write-Host "Done: $Name" -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

if ($Target -eq "int8") {
    Deploy-ModalApp -Name "whisper-quran-int8" -Dir "modal_whisper"
} elseif ($Target -eq "int4") {
    Deploy-ModalApp -Name "whisper-quran-int4" -Dir "modal_whisper_int4"
} elseif ($Target -eq "onnx") {
    Deploy-ModalApp -Name "whisper-quran-onnx" -Dir "modal_whisper_onnx"
} else {
    Deploy-ModalApp -Name "whisper-quran-int8" -Dir "modal_whisper"
    Deploy-ModalApp -Name "whisper-quran-int4" -Dir "modal_whisper_int4"
}

Write-Host ""
Write-Host "Set WHISPER_ENDPOINT_URL in backend .env to your Modal web URL (e.g. https://YOUR_WORKSPACE--whisper-quran-int8-web.modal.run)" -ForegroundColor Yellow
