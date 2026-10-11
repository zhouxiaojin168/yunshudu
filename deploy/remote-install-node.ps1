$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\yunshudu'
$ver = 'v22.20.0'
$name = 'node-' + $ver + '-win-x64'
$exe = Join-Path $root ('node\node.exe')
if (Test-Path $exe) { Write-Output 'node already present' }
else {
  $zip = Join-Path $root 'node.zip'
  $urls = @(
    'https://npmmirror.com/mirrors/node/' + $ver + '/' + $name + '.zip',
    'https://registry.npmmirror.com/-/binary/node/' + $ver + '/' + $name + '.zip',
    'https://nodejs.org/dist/' + $ver + '/' + $name + '.zip'
  )
  foreach ($u in $urls) {
    try {
      $t0 = Get-Date
      Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 600
      $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
      Write-Output ('downloaded ' + $u + '  ' + $mb + 'MB in ' + [math]::Round(((Get-Date) - $t0).TotalSeconds, 1) + 's')
      break
    } catch { Write-Output ('FAIL ' + $u + ' :: ' + $_.Exception.Message) }
  }
  if (Test-Path $zip) {
    $tmp = Join-Path $root 'nztmp'
    if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $d = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
    if (Test-Path (Join-Path $root 'node')) { Remove-Item -LiteralPath (Join-Path $root 'node') -Recurse -Force }
    Move-Item -LiteralPath $d.FullName -Destination (Join-Path $root 'node')
    Remove-Item -LiteralPath $zip -Force
    Write-Output 'extracted'
  }
}
if (Test-Path $exe) {
  Write-Output ('node -v => ' + (((& $exe -v) 2>&1) -join ' '))
  Write-Output ('node -p process.arch => ' + (((& $exe -p 'process.arch') 2>&1) -join ' '))
  $t = Join-Path $root 'sqlite-test.js'
  $js = "const s=require('node:sqlite');const d=new s.DatabaseSync(':memory:');d.exec('create table t(a)');d.prepare('insert into t values(1)').run();console.log('SQLITE_OK',d.prepare('select count(*) c from t').get().c);"
  Set-Content -LiteralPath $t -Value $js -Encoding ASCII
  Write-Output ('sqlite(noflag) => ' + (((& $exe $t) 2>&1) -join ' | '))
  Write-Output ('sqlite(flag)   => ' + (((& $exe --experimental-sqlite $t) 2>&1) -join ' | '))
} else { Write-Output 'NODE_NOT_INSTALLED' }
