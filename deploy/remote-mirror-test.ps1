try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'
$R = 'zhouxiaojin168/yunshudu'
$zip = '/' + $R + '/archive/refs/heads/main.zip'
$cands = New-Object System.Collections.ArrayList
[void]$cands.Add('https://api.github.com/repos/' + $R)
[void]$cands.Add('https://github.com/' + $R + '/archive/refs/heads/main.zip')
[void]$cands.Add('https://codeload.github.com/' + $R + '/zip/refs/heads/main')
[void]$cands.Add('https://ghproxy.net/https://github.com' + $zip)
[void]$cands.Add('https://ghfast.top/https://github.com' + $zip)
[void]$cands.Add('https://gh-proxy.com/https://github.com' + $zip)
[void]$cands.Add('https://hub.gitmirror.com/https://github.com' + $zip)
[void]$cands.Add('https://kkgithub.com' + $zip)
[void]$cands.Add('https://bgithub.xyz' + $zip)
[void]$cands.Add('https://cdn.jsdelivr.net/gh/' + $R + '@main/README.md')
[void]$cands.Add('https://fastly.jsdelivr.net/gh/' + $R + '@main/README.md')
[void]$cands.Add('https://gcore.jsdelivr.net/gh/' + $R + '@main/README.md')
[void]$cands.Add('https://raw.gitmirror.com/' + $R + '/main/README.md')
[void]$cands.Add('https://data.jsdelivr.com/v1/packages/gh/' + $R + '@main')
[void]$cands.Add('https://gitclone.com/github.com/' + $R)
foreach ($u in $cands) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-WebRequest -Uri $u -Method Head -TimeoutSec 15 -UseBasicParsing
    $sw.Stop()
    Write-Output ('OK   ' + $r.StatusCode + '  ' + $sw.ElapsedMilliseconds + 'ms  len=' + $r.Headers['Content-Length'] + '  ' + $u)
  } catch {
    $sw.Stop()
    $m = $_.Exception.Message
    if ($m.Length -gt 60) { $m = $m.Substring(0,60) }
    Write-Output ('FAIL ' + $sw.ElapsedMilliseconds + 'ms  ' + $m + '  ::  ' + $u)
  }
}
