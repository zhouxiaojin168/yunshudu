$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\yunshudu'
$cands = @('v24.21.0','v22.23.3')
foreach ($ver in $cands) {
  $name = 'node-' + $ver + '-win-x64'
  $dir  = Join-Path $root ('node-' + $ver)
  $exe  = Join-Path $dir 'node.exe'
  if (-not (Test-Path $exe)) {
    $zip  = Join-Path $root ($name + '.zip')
    $u1 = 'https://registry.npmmirror.com/-/binary/node/' + $ver + '/' + $name + '.zip'
    $u2 = 'https://nodejs.org/dist/' + $ver + '/' + $name + '.zip'
    $urls = New-Object System.Collections.ArrayList
    [void]$urls.Add($u1)
    [void]$urls.Add($u2)
    $got = $false
    foreach ($u in $urls) {
      try {
        $t0 = Get-Date
        Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 900
        Write-Output ($ver + ' downloaded ' + [math]::Round((Get-Item $zip).Length / 1MB, 1) + 'MB in ' + [math]::Round(((Get-Date) - $t0).TotalSeconds, 1) + 's from ' + $u)
        $got = $true
        break
      } catch { Write-Output ($ver + ' FAIL ' + $u + ' :: ' + $_.Exception.Message) }
    }
    if (-not $got) { continue }
    $tmp = Join-Path $root ('nztmp-' + $ver)
    if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $d = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
    if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    Move-Item -LiteralPath $d.FullName -Destination $dir
    Remove-Item -LiteralPath $zip -Force
    Remove-Item -LiteralPath $tmp -Recurse -Force
    Write-Output ($ver + ' extracted -> ' + $dir)
  }
  if (Test-Path $exe) {
    $vout = ((& $exe -v) 2>&1) -join ' '
    Write-Output ($ver + ' :: node -v => ' + $vout)
    if ($vout -match '^v\d+\.') {
      $t = Join-Path $root ('sqlite-test-' + $ver + '.js')
      $js = "const s=require('node:sqlite');const d=new s.DatabaseSync(':memory:');d.exec('create table t(a)');d.prepare('insert into t values(1)').run();console.log('SQLITE_OK',d.prepare('select count(*) c from t').get().c);"
      Set-Content -LiteralPath $t -Value $js -Encoding ASCII
      Write-Output ($ver + ' :: sqlite(noflag) => ' + ((((& $exe $t) 2>&1) -join ' | ')))
      Write-Output ($ver + ' :: sqlite(flag)   => ' + ((((& $exe --experimental-sqlite $t) 2>&1) -join ' | ')))
      Set-Content -LiteralPath (Join-Path $root 'node-active.txt') -Value $exe -Encoding ASCII
      break
    }
  }
}
if (-not (Test-Path (Join-Path $root 'node-active.txt'))) { Write-Output 'NODE_NOT_RUNNABLE_ON_THIS_OS' }
