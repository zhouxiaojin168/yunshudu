try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'
$R = 'zhouxiaojin168/yunshudu'
try {
  $c = Invoke-RestMethod ('https://api.github.com/repos/' + $R + '/commits/main') -TimeoutSec 20 -UseBasicParsing -Headers @{ 'User-Agent' = 'yunshudu-agent' }
  Write-Output ('api sha = ' + $c.sha)
  Write-Output ('api msg = ' + $c.commit.message)
} catch { Write-Output ('api sha ERR ' + $_.Exception.Message) }
$tmp = 'C:\yunshudu\tmp\main.zip'
New-Item -ItemType Directory -Force -Path (Split-Path $tmp) | Out-Null
$srcs = New-Object System.Collections.ArrayList
[void]$srcs.Add('https://codeload.github.com/' + $R + '/zip/refs/heads/main')
[void]$srcs.Add('https://github.com/' + $R + '/archive/refs/heads/main.zip')
[void]$srcs.Add('https://ghproxy.net/https://github.com/' + $R + '/archive/refs/heads/main.zip')
[void]$srcs.Add('https://gh-proxy.com/https://github.com/' + $R + '/archive/refs/heads/main.zip')
foreach ($u in $srcs) {
  try {
    $t0 = Get-Date
    Invoke-WebRequest -Uri $u -OutFile $tmp -TimeoutSec 60 -UseBasicParsing
    Write-Output ('zip OK ' + (Get-Item $tmp).Length + 'B in ' + [math]::Round(((Get-Date) - $t0).TotalSeconds, 1) + 's from ' + $u)
    break
  } catch { Write-Output ('zip FAIL ' + $_.Exception.Message + ' :: ' + $u) }
}
if (Test-Path $tmp) {
  $ex = 'C:\yunshudu\tmp\ex'
  if (Test-Path $ex) { Remove-Item -LiteralPath $ex -Recurse -Force }
  Expand-Archive -LiteralPath $tmp -DestinationPath $ex -Force
  $d = Get-ChildItem -LiteralPath $ex -Directory | Select-Object -First 1
  Write-Output ('extracted root = ' + $d.Name)
  Get-ChildItem -LiteralPath $d.FullName | ForEach-Object { Write-Output ('  ' + $_.Name) }
  Write-Output ('file count = ' + (Get-ChildItem -LiteralPath $d.FullName -Recurse -File).Count)
}
