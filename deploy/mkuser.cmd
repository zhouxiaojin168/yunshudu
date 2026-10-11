@echo off
chcp 65001 >nul
set OUT=\\tsclient\C\rdpshare\mkuser.out.txt
echo --- net user add --- > "%OUT%"
net user yunshudu Yunshudu-2026! /add >> "%OUT%" 2>&1
echo --- add to administrators --- >> "%OUT%"
net localgroup administrators yunshudu /add >> "%OUT%" 2>&1
echo --- add to RemoteManagementUsers --- >> "%OUT%"
powershell -NoProfile -Command "Get-LocalGroup -SID S-1-5-32-580 | ForEach-Object { Add-LocalGroupMember -Group $_ -Member yunshudu }" >> "%OUT%" 2>&1
echo --- verify net user --- >> "%OUT%"
net user yunshudu >> "%OUT%" 2>&1
echo --- verify admins --- >> "%OUT%"
net localgroup administrators >> "%OUT%" 2>&1
echo --- DONE --- >> "%OUT%"
type "%OUT%"
echo.
echo ==== FINISHED ====
ping -n 15 127.0.0.1 >nul
