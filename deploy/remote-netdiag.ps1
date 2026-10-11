try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'
$tests = @(
  'https://nodejs.org/dist/index.json',
  'https://nodejs.org/dist/v24.21.0/SHASUMS256.txt',
  'https://registry.npmmirror.com/-/binary/node/v24.21.0/SHASUMS256.txt',
  'https://registry.npmmirror.com/-/ping',
  'https://npmmirror.com/mirrors/node/index.json',
  'https://www.baidu.com',
  'https://registry.npmmirror.com/-/binary/node/v24.21.0/node-v24.21.0-win-x64.zip'
)
foreach ($u in $tests) {
  try {
    $r = Invoke-WebRequest -Uri $u -Method Head -TimeoutSec 25 -UseBasicParsing
    Write-Output ('HEAD ' + $r.StatusCode + '  len=' + $r.Headers['Content-Length'] + '  ' + $u)
  } catch {
    Write-Output ('HEAD ERR ' + $_.Exception.Message + '  ' + $u)
  }
}
Write-Output '--- proxy config ---'
try { $p = [System.Net.WebRequest]::DefaultWebRequestProxy; Write-Output ('default proxy = ' + $p) } catch {}
try { netsh winhttp show proxy } catch {}
