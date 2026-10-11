@echo off
chcp 65001 >nul
set OUT=\\tsclient\C\rdpshare\p1.out.txt
echo --- p1 start %DATE% %TIME% --- > "%OUT%"
if not exist C:\yunshudu mkdir C:\yunshudu
echo --- robocopy payload --- >> "%OUT%"
robocopy \\tsclient\C\rdpshare\payload C:\yunshudu /E /NFL /NDL /NP /R:1 /W:1 >> "%OUT%" 2>&1
echo robocopy_exit=%ERRORLEVEL% >> "%OUT%"
echo --- top level of C:\yunshudu --- >> "%OUT%"
dir C:\yunshudu >> "%OUT%" 2>&1
echo --- scripts count --- >> "%OUT%"
dir /b C:\yunshudu\scripts\*.js >> "%OUT%" 2>&1
echo --- size --- >> "%OUT%"
dir C:\yunshudu\new-api.exe >> "%OUT%" 2>&1
echo --- p1 DONE %DATE% %TIME% --- >> "%OUT%"
echo P1_FINISHED
type "%OUT%"
