$ErrorActionPreference = 'Continue'
$Root = 'C:\yunshudu'
foreach ($d in 'bin','state','releases','app','logs','tmp') { New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null }

Write-Output '--- 1) stop new-api ---'
Get-Process new-api -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

Write-Output '--- 2) move exe -> bin ---'
$exeOld = Join-Path $Root 'new-api.exe'
$exeNew = Join-Path $Root 'bin\new-api.exe'
if (Test-Path $exeOld) { Move-Item -LiteralPath $exeOld -Destination $exeNew -Force; Write-Output 'moved' }
Write-Output ('bin exists = ' + (Test-Path $exeNew))

Write-Output '--- 3) write launcher ---'
$runB64 = '77u/JHJvb3QgPSAnQzpceXVuc2h1ZHUnDQokc2VjID0gQHt9DQpmb3JlYWNoICgkbCBpbiAoR2V0LUNvbnRlbnQgLUxpdGVyYWxQYXRoIChKb2luLVBhdGggJHJvb3QgJ3NlY3JldHMudHh0JykpKSB7DQogIGlmICgkbCAtbWF0Y2ggJ14oW0EtWl9dKyk9KC4qKSQnKSB7ICRzZWNbJE1hdGNoZXNbMV1dID0gJE1hdGNoZXNbMl0gfQ0KfQ0KJGVudjpQT1JUID0gJzMwMDAnDQokZW52OlNFU1NJT05fU0VDUkVUID0gJHNlY1snU0VTU0lPTl9TRUNSRVQnXQ0KJGVudjpDUllQVE9fU0VDUkVUICA9ICRzZWNbJ0NSWVBUT19TRUNSRVQnXQ0KJGVudjpHSU5fTU9ERSA9ICdyZWxlYXNlJw0KJGVudjpUWiA9ICdBc2lhL1NoYW5naGFpJw0KJGVudjpOT0RFX05BTUUgPSAnc3J2LTIyNScNCiRkYXRhID0gSm9pbi1QYXRoICRyb290ICdkYXRhJw0KJGxvZ2QgPSBKb2luLVBhdGggJHJvb3QgJ2xvZ3MnDQokZXhlID0gSm9pbi1QYXRoICRyb290ICdiaW5cbmV3LWFwaS5leGUnDQokcCA9IFN0YXJ0LVByb2Nlc3MgLUZpbGVQYXRoICRleGUgLVdvcmtpbmdEaXJlY3RvcnkgJGRhdGEgLVJlZGlyZWN0U3RhbmRhcmRPdXRwdXQgKEpvaW4tUGF0aCAkbG9nZCAnbmV3LWFwaS5vdXQubG9nJykgLVJlZGlyZWN0U3RhbmRhcmRFcnJvciAoSm9pbi1QYXRoICRsb2dkICduZXctYXBpLmVyci5sb2cnKSAtV2luZG93U3R5bGUgSGlkZGVuIC1QYXNzVGhydQ0KU2V0LUNvbnRlbnQgLUxpdGVyYWxQYXRoIChKb2luLVBhdGggJGxvZ2QgJ25ldy1hcGkucGlkJykgLVZhbHVlICRwLklkIC1FbmNvZGluZyBBU0NJSQ0KJHAuV2FpdEZvckV4aXQoKQ0K'
[System.IO.File]::WriteAllBytes((Join-Path $Root 'run-new-api.ps1'), [Convert]::FromBase64String($runB64))
Write-Output ('launcher written ' + (Get-Item (Join-Path $Root 'run-new-api.ps1')).Length + 'B')

Write-Output '--- 4) move repo content -> app ---'
foreach ($n in 'scripts','web','config','docs') {
  $src = Join-Path $Root $n
  $dst = Join-Path $Root ('app\' + $n)
  if (Test-Path $src) {
    if (Test-Path $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
    Move-Item -LiteralPath $src -Destination $dst -Force
    Write-Output ('  ' + $n + ' -> app\' + $n)
  }
}
Get-ChildItem -LiteralPath (Join-Path $Root 'app') -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('  app/' + $_.Name) }

Write-Output '--- 5) install deploy-agent ---'
$agentB64 = '77u/PCMKICBkZXBsb3ktYWdlbnQucHMxIC0tIOacjeWKoeWZqOS+p+OAjEdpdEh1YiAtPiDmnKzmnLrjgI3oh6rliqjpg6jnvbLku6PnkIbvvIjnlLHorqHliJLku7vliqEgeXVuc2h1ZHUtZGVwbG95IOWumuaXtuiwg+eUqO+8iQogICAg5rWB56iLOiDlj5bov5znq68gbWFpbiBTSEEgLT4g5LiO54q25oCB5q+U5a+5IC0+IOS4i+i9vSB6aXAo5aSa5rqQ5Zue6YCAKSAtPiDop6PljIXliLAgcmVsZWFzZXNcPHNoYT4KICAgICAgICAgIC0+IHJvYm9jb3B5IC9NSVIg5ZCM5q2l5YiwIGFwcFwgLT4g6LeRIGFwcFxkZXBsb3lccG9zdC1kZXBsb3kucHMxIC0+IOiusOW9lSBTSEEgLT4g5riF55CG5pen54mI5pysCiAgICDlj4LmlbA6IC1Gb3JjZSDlvLrliLbph43pg6jnvbLvvJstUXVpZXQg5LiN5YaZ5o6n5Yi25Y+w77yI5Y+q5YaZ5pel5b+X77yJCiM+CnBhcmFtKAogIFtzd2l0Y2hdJEZvcmNlLAogIFtzd2l0Y2hdJFF1aWV0CikKJEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICdDb250aW51ZScKdHJ5IHsgW05ldC5TZXJ2aWNlUG9pbnRNYW5hZ2VyXTo6U2VjdXJpdHlQcm90b2NvbCA9IFtOZXQuU2VjdXJpdHlQcm90b2NvbFR5cGVdOjpUbHMxMiB9IGNhdGNoIHt9CiRQcm9ncmVzc1ByZWZlcmVuY2UgPSAnU2lsZW50bHlDb250aW51ZScKCiRSb290ICAgPSAnQzpceXVuc2h1ZHUnCiRSZXBvICAgPSAnemhvdXhpYW9qaW4xNjgveXVuc2h1ZHUnCiRCcmFuY2ggPSAnbWFpbicKJFN0YXRlRCA9IEpvaW4tUGF0aCAkUm9vdCAnc3RhdGUnCiRSZWxEICAgPSBKb2luLVBhdGggJFJvb3QgJ3JlbGVhc2VzJwokQXBwRCAgID0gSm9pbi1QYXRoICRSb290ICdhcHAnCiRMb2dEICAgPSBKb2luLVBhdGggJFJvb3QgJ2xvZ3MnCiRUbXBEICAgPSBKb2luLVBhdGggJFJvb3QgJ3RtcCcKJExvZyAgICA9IEpvaW4tUGF0aCAkTG9nRCAnZGVwbG95LmxvZycKJFNoYUYgICA9IEpvaW4tUGF0aCAkU3RhdGVEICdkZXBsb3llZC1zaGEudHh0JwokTG9jayAgID0gSm9pbi1QYXRoICRTdGF0ZUQgJ2RlcGxveS5sb2NrJwoKZm9yZWFjaCAoJGQgaW4gQCgkU3RhdGVELCAkUmVsRCwgJEFwcEQsICRMb2dELCAkVG1wRCkpIHsgTmV3LUl0ZW0gLUl0ZW1UeXBlIERpcmVjdG9yeSAtRm9yY2UgLVBhdGggJGQgfCBPdXQtTnVsbCB9CgpmdW5jdGlvbiBMKCRtKSB7CiAgJHMgPSAoJ1t7MH1dIHsxfScgLWYgKEdldC1EYXRlIC1Gb3JtYXQgJ3l5eXktTU0tZGQgSEg6bW06c3MnKSwgJG0pCiAgQWRkLUNvbnRlbnQgLUxpdGVyYWxQYXRoICRMb2cgLVZhbHVlICRzCiAgaWYgKC1ub3QgJFF1aWV0KSB7IFdyaXRlLU91dHB1dCAkcyB9Cn0KCiMg6Ziy6YeN5YWlCmlmIChUZXN0LVBhdGggJExvY2spIHsKICAkYWdlID0gKEdldC1EYXRlKSAtIChHZXQtSXRlbSAkTG9jaykuTGFzdFdyaXRlVGltZQogIGlmICgkYWdlLlRvdGFsTWludXRlcyAtbHQgMTApIHsgZXhpdCAwIH0KfQpTZXQtQ29udGVudCAtTGl0ZXJhbFBhdGggJExvY2sgLVZhbHVlIChHZXQtRGF0ZSAtRm9ybWF0IG8pIC1FbmNvZGluZyBBU0NJSQp0cnkgewoKTCAnPT09IGRlcGxveS1hZ2VudCBydW4gPT09JwoKIyAxKSDov5znq6/mnIDmlrAgU0hBCiRzaGEgPSAkbnVsbDsgJG1zZyA9ICcnCnRyeSB7CiAgJGMgPSBJbnZva2UtUmVzdE1ldGhvZCAoJ2h0dHBzOi8vYXBpLmdpdGh1Yi5jb20vcmVwb3MvJyArICRSZXBvICsgJy9jb21taXRzLycgKyAkQnJhbmNoKSAtVGltZW91dFNlYyAyMCAtVXNlQmFzaWNQYXJzaW5nIC1IZWFkZXJzIEB7ICdVc2VyLUFnZW50JyA9ICd5dW5zaHVkdS1hZ2VudCcgfQogICRzaGEgPSAkYy5zaGEKICBpZiAoJGMuY29tbWl0KSB7ICRtc2cgPSBbc3RyaW5nXSRjLmNvbW1pdC5tZXNzYWdlIH0KICBMICgncmVtb3RlIHNoYSA9ICcgKyAkc2hhICsgJyA6OiAnICsgJG1zZykKfSBjYXRjaCB7IEwgKCdyZW1vdGUgc2hhIEZBSUwgJyArICRfLkV4Y2VwdGlvbi5NZXNzYWdlKSB9CgppZiAoLW5vdCAkc2hhKSB7IEwgJ25vIHNoYSAtPiBhYm9ydCc7IGV4aXQgMSB9CiRjdXIgPSAnJwppZiAoVGVzdC1QYXRoICRTaGFGKSB7ICRjdXIgPSAoR2V0LUNvbnRlbnQgLUxpdGVyYWxQYXRoICRTaGFGIC1SYXcpLlRyaW0oKSB9CmlmICgkc2hhIC1lcSAkY3VyIC1hbmQgLW5vdCAkRm9yY2UpIHsgTCAoJ3VwLXRvLWRhdGUgKCcgKyAkY3VyLlN1YnN0cmluZygwLDcpICsgJyknKTsgZXhpdCAwIH0KTCAoJ2RlcGxveSAnICsgJChpZiAoJGN1cikgeyAkY3VyLlN1YnN0cmluZygwLDcpIH0gZWxzZSB7ICdub25lJyB9KSArICcgLT4gJyArICRzaGEuU3Vic3RyaW5nKDAsNykpCgojIDIpIOS4i+i9vSB6aXDvvIjlpJrmupDlm57pgIDvvIkKJHppcCAgPSBKb2luLVBhdGggJFRtcEQgKCRzaGEgKyAnLnppcCcpCiRzcmNzID0gTmV3LU9iamVjdCBTeXN0ZW0uQ29sbGVjdGlvbnMuQXJyYXlMaXN0Clt2b2lkXSRzcmNzLkFkZCgnaHR0cHM6Ly9jb2RlbG9hZC5naXRodWIuY29tLycgKyAkUmVwbyArICcvemlwL3JlZnMvaGVhZHMvJyArICRCcmFuY2gpClt2b2lkXSRzcmNzLkFkZCgnaHR0cHM6Ly9naXRodWIuY29tLycgKyAkUmVwbyArICcvYXJjaGl2ZS9yZWZzL2hlYWRzLycgKyAkQnJhbmNoICsgJy56aXAnKQpbdm9pZF0kc3Jjcy5BZGQoJ2h0dHBzOi8vZ2hwcm94eS5uZXQvaHR0cHM6Ly9naXRodWIuY29tLycgKyAkUmVwbyArICcvYXJjaGl2ZS9yZWZzL2hlYWRzLycgKyAkQnJhbmNoICsgJy56aXAnKQpbdm9pZF0kc3Jjcy5BZGQoJ2h0dHBzOi8vZ2gtcHJveHkuY29tL2h0dHBzOi8vZ2l0aHViLmNvbS8nICsgJFJlcG8gKyAnL2FyY2hpdmUvcmVmcy9oZWFkcy8nICsgJEJyYW5jaCArICcuemlwJykKJGdvdCA9ICRmYWxzZQpmb3JlYWNoICgkdSBpbiAkc3JjcykgewogIHRyeSB7CiAgICAkdDAgPSBHZXQtRGF0ZQogICAgSW52b2tlLVdlYlJlcXVlc3QgLVVyaSAkdSAtT3V0RmlsZSAkemlwIC1UaW1lb3V0U2VjIDEyMCAtVXNlQmFzaWNQYXJzaW5nCiAgICBMICgnZG93bmxvYWRlZCAnICsgKEdldC1JdGVtICR6aXApLkxlbmd0aCArICdCIGluICcgKyBbbWF0aF06OlJvdW5kKCgoR2V0LURhdGUpLSR0MCkuVG90YWxTZWNvbmRzLDEpICsgJ3MgZnJvbSAnICsgJHUpCiAgICAkZ290ID0gJHRydWUKICAgIGJyZWFrCiAgfSBjYXRjaCB7IEwgKCdkb3dubG9hZCBGQUlMICcgKyAkdSArICcgOjogJyArICRfLkV4Y2VwdGlvbi5NZXNzYWdlKSB9Cn0KaWYgKC1ub3QgJGdvdCkgeyBMICdhbGwgc291cmNlcyBmYWlsZWQgLT4gYWJvcnQnOyBleGl0IDIgfQoKIyAzKSDop6PljIXliLAgcmVsZWFzZXNcPHNoYT4KJHJlbCAgID0gSm9pbi1QYXRoICRSZWxEICRzaGEKJHRtcEV4ID0gSm9pbi1QYXRoICRUbXBEICgnZXgtJyArICRzaGEpCmlmIChUZXN0LVBhdGggJHRtcEV4KSB7IFJlbW92ZS1JdGVtIC1MaXRlcmFsUGF0aCAkdG1wRXggLVJlY3Vyc2UgLUZvcmNlIH0KRXhwYW5kLUFyY2hpdmUgLUxpdGVyYWxQYXRoICR6aXAgLURlc3RpbmF0aW9uUGF0aCAkdG1wRXggLUZvcmNlCiRpbm5lciA9IEdldC1DaGlsZEl0ZW0gLUxpdGVyYWxQYXRoICR0bXBFeCAtRGlyZWN0b3J5IHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQppZiAoLW5vdCAkaW5uZXIpIHsgTCAnemlwIGlubmVyIGRpciBtaXNzaW5nIC0+IGFib3J0JzsgZXhpdCAzIH0KaWYgKFRlc3QtUGF0aCAkcmVsKSB7IFJlbW92ZS1JdGVtIC1MaXRlcmFsUGF0aCAkcmVsIC1SZWN1cnNlIC1Gb3JjZSB9Ck1vdmUtSXRlbSAtTGl0ZXJhbFBhdGggJGlubmVyLkZ1bGxOYW1lIC1EZXN0aW5hdGlvbiAkcmVsClJlbW92ZS1JdGVtIC1MaXRlcmFsUGF0aCAkdG1wRXggLVJlY3Vyc2UgLUZvcmNlClJlbW92ZS1JdGVtIC1MaXRlcmFsUGF0aCAkemlwIC1Gb3JjZQpMICgncmVsZWFzZSAtPiAnICsgJHJlbCkKCiMgNCkg5ZCM5q2l5YiwIGFwcAomIHJvYm9jb3B5ICRyZWwgJEFwcEQgL01JUiAvTkZMIC9OREwgL05QIC9SOjEgL1c6MSB8IE91dC1OdWxsCiRyYyA9ICRMQVNURVhJVENPREUKTCAoJ3JvYm9jb3B5IGFwcCByYz0nICsgJHJjKQppZiAoJHJjIC1nZSA4KSB7IEwgJ3JvYm9jb3B5IEZBSUxFRCAtPiBhYm9ydCc7IGV4aXQgNCB9CgojIDUpIHBvc3QtZGVwbG95CiRob29rID0gSm9pbi1QYXRoICRBcHBEICdkZXBsb3lccG9zdC1kZXBsb3kucHMxJwppZiAoVGVzdC1QYXRoICRob29rKSB7CiAgTCAncnVubmluZyBwb3N0LWRlcGxveS5wczEnCiAgJG91dCA9ICYgcG93ZXJzaGVsbC5leGUgLU5vUHJvZmlsZSAtRXhlY3V0aW9uUG9saWN5IEJ5cGFzcyAtRmlsZSAkaG9vayAtUm9vdCAkUm9vdCAtU2hhICRzaGEgMj4mMQogIGZvcmVhY2ggKCRsIGluICRvdXQpIHsgTCAoJyAgcG9zdCB8ICcgKyAkbCkgfQp9IGVsc2UgeyBMICdubyBwb3N0LWRlcGxveSBob29rJyB9CgojIDYpIOiusOW9lQpTZXQtQ29udGVudCAtTGl0ZXJhbFBhdGggJFNoYUYgLVZhbHVlICRzaGEgLUVuY29kaW5nIEFTQ0lJCkwgKCdET05FIGRlcGxveWVkICcgKyAkc2hhKQoKIyA3KSDmuIXnkIbml6cgcmVsZWFzZe+8iOS/neeVmeacgOi/kSA1IOS4qu+8iQokYWxsID0gR2V0LUNoaWxkSXRlbSAtTGl0ZXJhbFBhdGggJFJlbEQgLURpcmVjdG9yeSB8IFNvcnQtT2JqZWN0IExhc3RXcml0ZVRpbWUgLURlc2NlbmRpbmcKJGtlZXAgPSAkYWxsIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgNQpmb3JlYWNoICgkbyBpbiAkYWxsKSB7CiAgaWYgKCRrZWVwLk5hbWUgLW5vdGNvbnRhaW5zICRvLk5hbWUpIHsKICAgIHRyeSB7IFJlbW92ZS1JdGVtIC1MaXRlcmFsUGF0aCAkby5GdWxsTmFtZSAtUmVjdXJzZSAtRm9yY2U7IEwgKCdwcnVuZWQgJyArICRvLk5hbWUpIH0gY2F0Y2ggeyBMICgncHJ1bmUgRkFJTCAnICsgJG8uTmFtZSkgfQogIH0KfQoKfSBmaW5hbGx5IHsKICBSZW1vdmUtSXRlbSAtTGl0ZXJhbFBhdGggJExvY2sgLUZvcmNlIC1FcnJvckFjdGlvbiBTaWxlbnRseUNvbnRpbnVlCn0K'
[System.IO.File]::WriteAllBytes((Join-Path $Root 'deploy-agent.ps1'), [Convert]::FromBase64String($agentB64))
Write-Output ('agent written ' + (Get-Item (Join-Path $Root 'deploy-agent.ps1')).Length + 'B')

Write-Output '--- 6) register tasks ---'
try { Unregister-ScheduledTask -TaskName 'yunshudu-new-api' -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch { }
$prin = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$act1 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\yunshudu\run-new-api.ps1'
$trg1 = New-ScheduledTaskTrigger -AtStartup
$set1 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'yunshudu-new-api' -Action $act1 -Trigger $trg1 -Principal $prin -Settings $set1 -Force | Out-Null
Write-Output 'task yunshudu-new-api registered'

try { Unregister-ScheduledTask -TaskName 'yunshudu-deploy' -Confirm:$false -ErrorAction Stop; Write-Output 'old deploy task removed' } catch { }
$act2 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\yunshudu\deploy-agent.ps1 -Quiet'
$trg2a = New-ScheduledTaskTrigger -AtStartup
$trg2b = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$set2 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'yunshudu-deploy' -Action $act2 -Trigger @($trg2a, $trg2b) -Principal $prin -Settings $set2 -Force | Out-Null
Write-Output 'task yunshudu-deploy registered (every 2 min + at startup)'

Write-Output '--- 7) start new-api ---'
Start-ScheduledTask -TaskName 'yunshudu-new-api'
Start-Sleep -Seconds 10
Get-Process new-api -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('  new-api pid=' + $_.Id) }
& netstat -ano | Select-String ':3000' | ForEach-Object { Write-Output ('  ' + $_.ToString().Trim()) }

Write-Output '--- 8) first deploy run ---'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'deploy-agent.ps1') -Force

Write-Output '--- 9) final ---'
Write-Output ('deployed-sha = ' + ((Get-Content -LiteralPath (Join-Path $Root 'state\deployed-sha.txt') -Raw -ErrorAction SilentlyContinue) -replace '\s',''))
Write-Output ('app file count = ' + (Get-ChildItem -LiteralPath (Join-Path $Root 'app') -Recurse -File).Count)
Get-ScheduledTask -TaskName 'yunshudu-new-api','yunshudu-deploy' | ForEach-Object { Write-Output ('  ' + $_.TaskName + ' state=' + $_.State) }
