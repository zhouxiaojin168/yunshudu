# download-release.ps1 -- 下载 new-api Windows 预编译并做 SHA256 校验
# 用法: powershell -ExecutionPolicy Bypass -File .\scripts\download-release.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Bin  = Join-Path $Root 'runtime\bin'
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
$exe = Join-Path $Bin 'new-api.exe'

$ver    = if ($env:NEWAPI_VERSION) { $env:NEWAPI_VERSION } else { 'v1.0.0-rc.43' }
$url    = "https://github.com/QuantumNous/new-api/releases/download/$ver/new-api-$ver.exe"
$expect = '3719f505ad805ab7b565a73acb18259cd1b2bed3a91d33a162b77124fe139748'   # v1.0.0-rc.43

Write-Host "downloading $url"
# 用系统 curl，带 -C - 断点续传（Node fetch 超时会留半截文件）
& "$env:SystemRoot\System32\curl.exe" -L -C - -o $exe $url
if ($LASTEXITCODE -ne 0) { throw "curl failed ($LASTEXITCODE)" }

$sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
Write-Host "sha256 = $sha"
if ($sha -ne $expect) { throw "SHA256 mismatch! expected $expect" }
Write-Host "OK  校验通过 -> $exe"