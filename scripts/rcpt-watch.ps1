$ErrorActionPreference = 'Continue'
$root       = 'E:\中转站测试\_ops\rcpt-watch'
$state      = Join-Path $root 'state.jsonl'
$alertDir   = Join-Path $root 'alerts'
$targetsFile= Join-Path $root 'targets.txt'
$domain     = 'qingzhou.autos'
$workRoot   = 'D:\破甲\1\OpenAI.Codex_26.715.3651.0_x64(免安装版 适合大多数电脑)\.codex\work'
if(-not (Test-Path $workRoot)){ $workRoot = Join-Path $env:CODEX_HOME 'work' }
$workLog    = Join-Path $workRoot 'RCPT-WATCH-ALERT.md'
$SKIP_PREFIX= @('postmaster@','abuse@')

if(-not (Test-Path $root)){ New-Item -ItemType Directory -Path $root -Force | Out-Null }
if(-not (Test-Path $alertDir)){ New-Item -ItemType Directory -Path $alertDir -Force | Out-Null }

function Get-MxHosts([string]$d){
  $out = @()
  foreach($srv in @('1.1.1.1','8.8.8.8')){
    try{
      $r = Resolve-DnsName -Name $d -Type MX -Server $srv -ErrorAction Stop | Where-Object { $_.NameExchange }
      if($r){
        $out = @($r | Sort-Object Preference | ForEach-Object { ($_.NameExchange -replace '\.$','') })
        if($out.Count -gt 0){ break }
      }
    }catch{}
  }
  return $out
}

function ReadReply($rd){
  $o=@()
  while($true){
    $l=$rd.ReadLine()
    if($l -eq $null){ break }
    $o+=$l
    if($l.Length -ge 4 -and $l[3] -eq ' '){ break }
  }
  return (($o -join ' ') -replace '\s+',' ')
}

function ProbeHost([string]$host_, [string]$rcpt){
  $res = [ordered]@{ host=$host_; rcpt=$rcpt; code='ERR'; text='' }
  $c = $null
  try{
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($host_, 25, $null, $null)
    if(-not $iar.AsyncWaitHandle.WaitOne(12000)){ throw 'connect timeout' }
    $c.EndConnect($iar)
    $st = $c.GetStream()
    $rd = New-Object System.IO.StreamReader($st)
    $wr = New-Object System.IO.StreamWriter($st); $wr.AutoFlush = $true
    Start-Sleep -Milliseconds 300; $null = ReadReply $rd
    $wr.WriteLine('EHLO watch.local');             Start-Sleep -Milliseconds 400; $null = ReadReply $rd
    $wr.WriteLine('MAIL FROM:<watch@example.com>');Start-Sleep -Milliseconds 400; $null = ReadReply $rd
    $wr.WriteLine("RCPT TO:<$rcpt>");              Start-Sleep -Milliseconds 900
    $rn = ReadReply $rd
    $wr.WriteLine('QUIT')
    $res.code = $rn.Substring(0,[Math]::Min(3,$rn.Length))
    $res.text = $rn
  } catch {
    $res.text = $_.Exception.Message
  } finally {
    if($c){ try{ $c.Close() }catch{} }
  }
  return $res
}

$mxHosts = Get-MxHosts $domain
if($mxHosts.Count -eq 0){ $mxHosts = @('smtp.google.com','aspmx.l.google.com') }
if($mxHosts.Count -gt 3){ $mxHosts = @($mxHosts[0..2]) }

$targets = @()
if(Test-Path $targetsFile){
  $targets = Get-Content -LiteralPath $targetsFile -Encoding UTF8 | Where-Object { $_ -and ($_.Trim() -ne '') -and (-not $_.Trim().StartsWith('#')) } | ForEach-Object { $_.Trim() }
}
if($targets.Count -eq 0){ $targets = @('yipian01@qingzhou.autos','yipian@qingzhou.autos','hlwatch@qingzhou.autos') }

$stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
$results = @()
$positive = @()
foreach($t in $targets){
  foreach($h in $mxHosts){
    $r = ProbeHost $h $t
    $results += ,$r
    $skip = $false
    foreach($pfx in $SKIP_PREFIX){ if($t.StartsWith($pfx)){ $skip = $true } }
    if(($r.code -eq '250') -and (-not $skip)){ $positive += ($t + ' @ ' + $h + ' -> ' + $r.text) }
    Start-Sleep -Milliseconds 150
  }
}

$rec = [ordered]@{ ts=$stamp; mx=@($mxHosts); targets=$targets; results=$results; positive=$positive }
[System.IO.File]::AppendAllText($state, (($rec | ConvertTo-Json -Compress -Depth 6) + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

try{
  $all = [System.IO.File]::ReadAllLines($state)
  if($all.Count -gt 2000){ [System.IO.File]::WriteAllLines($state, $all[($all.Count-2000)..($all.Count-1)], (New-Object System.Text.UTF8Encoding($false))) }
}catch{}

if($positive.Count -gt 0){
  $af = Join-Path $alertDir ('ALERT-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.txt')
  [System.IO.File]::WriteAllText($af, ($stamp + "  MX=" + ($mxHosts -join ',') + "`r`n" + ($positive -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  if($workLog){
    if(-not (Test-Path $workLog)){ [System.IO.File]::WriteAllText($workLog, "# RCPT-WATCH 报警（$domain 收信）`r`n", (New-Object System.Text.UTF8Encoding($false))) }
    $msg = "`r`n- **$stamp** 有地址返回 250（MX=" + ($mxHosts -join ',') + "）-> 收信通道打通！`r`n" + (($positive | ForEach-Object { "  - " + $_ }) -join "`r`n") + "`r`n"
    [System.IO.File]::AppendAllText($workLog, $msg, (New-Object System.Text.UTF8Encoding($false)))
  }
  Write-Host ('ALERT ' + $stamp + ' :: ' + ($positive -join ' | '))
} else {
  $sum = ($results | ForEach-Object { ($_.rcpt.Split('@')[0]) + '=' + $_.code }) -join ' '
  Write-Host ('no-change ' + $stamp + ' :: MX=' + ($mxHosts -join ',') + ' :: ' + $sum)
}