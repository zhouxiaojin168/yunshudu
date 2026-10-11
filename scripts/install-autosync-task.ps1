# install-autosync-task.ps1 -- 注册 Windows 计划任务：每 10 分钟兜底同步一次
#   不需要管理员权限（当前用户 + 有限权限）
#   卸载：Unregister-ScheduledTask -TaskName 'yunshudu-autosync' -Confirm:$false
param([int]$Minutes = 10, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$TaskName = 'yunshudu-autosync'
$Root = Split-Path -Parent $PSScriptRoot

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host ('已卸载计划任务 ' + $TaskName)
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\node-v\node.exe' }
$script = Join-Path $Root 'scripts\auto-sync.js'

# 走 wrapper：它负责把 token 注入环境（计划任务环境里通常没有 CODEX_HOME）
$wrapper = Join-Path $Root 'scripts\autosync-once.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
          -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $wrapper + '"') `
          -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $Minutes)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host ('已注册计划任务 ' + $TaskName + '：每 ' + $Minutes + ' 分钟跑一次 auto-sync.js --once')
Write-Host '立即试跑一次...'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 8
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object TaskName, LastRunTime, LastTaskResult, NextRunTime | Format-List | Out-String