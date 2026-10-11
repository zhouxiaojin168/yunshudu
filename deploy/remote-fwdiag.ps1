$ErrorActionPreference='Continue'
Write-Output '--- profiles ---'
Get-NetFirewallProfile | ForEach-Object { Write-Output ('  ' + $_.Name + ' Enabled=' + $_.Enabled + ' Inbound=' + $_.DefaultInboundAction + ' Outbound=' + $_.DefaultOutboundAction) }
Write-Output '--- rules mentioning 3000 ---'
Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'yunshudu|3000' } | ForEach-Object { Write-Output ('  ' + $_.DisplayName + ' dir=' + $_.Direction + ' enabled=' + $_.Enabled + ' action=' + $_.Action + ' profile=' + $_.Profile) }
Write-Output '--- all enabled inbound BLOCK rules ---'
Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' -and $_.Action -eq 'Block' } | ForEach-Object { Write-Output ('  BLOCK ' + $_.DisplayName + ' profile=' + $_.Profile) }
Write-Output '--- third party fw services ---'
Get-Service | Where-Object { $_.DisplayName -match 'firewall|360|安全|Guard' } | ForEach-Object { Write-Output ('  ' + $_.Status + ' ' + $_.Name + ' :: ' + $_.DisplayName) }
Write-Output '--- netstat 3000 ---'
& netstat -ano | Select-String ':3000' | ForEach-Object { Write-Output ('  ' + $_.ToString().Trim()) }
Write-Output '--- self test via public IP ---'
try { $r = Invoke-WebRequest -Uri 'http://114.66.16.225:3000/api/status' -UseBasicParsing -TimeoutSec 10; Write-Output ('  SELF-PUBLIC OK ' + $r.StatusCode) } catch { Write-Output ('  SELF-PUBLIC ERR ' + $_.Exception.Message) }
Write-Output '--- self test via LAN IP ---'
try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/status' -UseBasicParsing -TimeoutSec 10; Write-Output ('  SELF-LOOP OK ' + $r.StatusCode) } catch { Write-Output ('  SELF-LOOP ERR ' + $_.Exception.Message) }
