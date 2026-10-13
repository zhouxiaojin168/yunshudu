# 安装/更新「qingzhou.autos 收信探测」计划任务（每小时一次，隐藏窗口）
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-rcpt-watch-task.ps1
$ErrorActionPreference = 'Stop'
$script = 'E:\中转站测试\_ops\rcpt-watch\rcpt-watch.ps1'
if(-not (Test-Path $script)){
  $alt = Join-Path $PSScriptRoot 'rcpt-watch.ps1'
  if(Test-Path $alt){ $script = $alt } else { throw "找不到 rcpt-watch.ps1" }
}
$dir = Split-Path $script -Parent
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"') `
  -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) `
  -RepetitionInterval (New-TimeSpan -Minutes 60) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'qingzhou-rcpt-watch' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description '每小时探测 qingzhou.autos 收信是否已打通（按真实 MX 动态解析）' -Force | Out-Null
Get-ScheduledTask -TaskName 'qingzhou-rcpt-watch' | Select-Object TaskName,State | Format-Table -AutoSize
Get-ScheduledTaskInfo -TaskName 'qingzhou-rcpt-watch' | Select-Object NextRunTime,LastTaskResult | Format-List