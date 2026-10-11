param([int]$Port = 3000)
$ErrorActionPreference = 'Continue'
$root = 'C:\yunshudu'
$bin  = Join-Path $root 'new-api.exe'
$data = Join-Path $root 'data'
$logd = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $data, $logd | Out-Null
$secFile = Join-Path $root 'secrets.txt'
if (-not (Test-Path $secFile)) {
  $rnd = New-Object System.Random
  $chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  $s1 = -join (1..32 | ForEach-Object { $chars[$rnd.Next($chars.Length)] })
  $s2 = -join (1..32 | ForEach-Object { $chars[$rnd.Next($chars.Length)] })
  Set-Content -LiteralPath $secFile -Value @(('SESSION_SECRET=' + $s1), ('CRYPTO_SECRET=' + $s2)) -Encoding ASCII
  Write-Output 'secrets generated'
}
$sec = @{}
foreach ($l in (Get-Content -LiteralPath $secFile)) { if ($l -match '^([A-Z_]+)=(.*)$') { $sec[$Matches[1]] = $Matches[2] } }
Get-Process new-api -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$env:PORT = [string]$Port
$env:SESSION_SECRET = $sec['SESSION_SECRET']
$env:CRYPTO_SECRET  = $sec['CRYPTO_SECRET']
$env:GIN_MODE = 'release'
$env:TZ = 'Asia/Shanghai'
$env:NODE_NAME = 'srv-225'
$out = Join-Path $logd 'new-api.out.log'
$err = Join-Path $logd 'new-api.err.log'
$p = Start-Process -FilePath $bin -WorkingDirectory $data -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $logd 'new-api.pid') -Value $p.Id -Encoding ASCII
Write-Output ('started new-api pid=' + $p.Id + ' port=' + $Port)
Start-Sleep -Seconds 8
& netsh advfirewall firewall delete rule name="yunshudu-api" | Out-Null
& netsh advfirewall firewall add rule name="yunshudu-api" dir=in action=allow protocol=TCP localport=$Port | Out-Null
& netsh advfirewall firewall delete rule name="yunshudu-api80" | Out-Null
& netsh advfirewall firewall add rule name="yunshudu-api80" dir=in action=allow protocol=TCP localport=80 | Out-Null
Write-Output 'firewall yunshudu-api:'
& netsh advfirewall firewall show rule name="yunshudu-api" | ForEach-Object { Write-Output ('  ' + $_.Trim()) }
Write-Output 'listen:'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $Port } | ForEach-Object { Write-Output ('  listen ' + $_.LocalAddress + ':' + $_.LocalPort + ' pid=' + $_.OwningProcess) }
Write-Output ('proc alive = ' + [bool](Get-Process -Id $p.Id -ErrorAction SilentlyContinue))
Write-Output '--- err log tail ---'
if (Test-Path $err) { Get-Content -LiteralPath $err -Tail 15 | ForEach-Object { Write-Output ('  ' + $_) } }
Write-Output '--- out log tail ---'
if (Test-Path $out) { Get-Content -LiteralPath $out -Tail 25 | ForEach-Object { Write-Output ('  ' + $_) } }
try { $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/api/status') -UseBasicParsing -TimeoutSec 10; Write-Output ('LOCAL /api/status ' + $r.StatusCode + ' :: ' + $r.Content) } catch { Write-Output ('LOCAL /api/status ERR ' + $_.Exception.Message) }
