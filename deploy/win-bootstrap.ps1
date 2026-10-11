<#
  win-bootstrap.ps1 -- 新服务器第一枪（在 RDP 会话里跑一次）
    作用：打开 WinRM(5985, Basic+AllowUnencrypted) + 去掉防火墙 profile 限制 + 探测外网可达性
    产出：C:\yunshudu\bootstrap.log、C:\yunshudu\bootstrap.done
    之后所有部署动作都通过 WinRM 远程完成，不再需要 RDP 手工操作。
#>
$ErrorActionPreference = 'Continue'
# Server 2012R2 默认不开 TLS1.2，不设这一行所有 https 探测都会 FAIL
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls } catch {}
$ProgressPreference = 'SilentlyContinue'
$Root = 'C:\yunshudu'
$log  = Join-Path $Root 'bootstrap.log'
New-Item -ItemType Directory -Force -Path $Root | Out-Null
function L($m) {
  $s = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
  Add-Content -LiteralPath $log -Value $s -Encoding UTF8
  Write-Host $s
}
L '=== win-bootstrap start ==='
L ('whoami = ' + (whoami))
try { $os = Get-CimInstance Win32_OperatingSystem; L ('os = ' + $os.Caption + ' build=' + $os.BuildNumber + ' arch=' + $os.OSArchitecture) } catch {}
L ('ps = ' + $PSVersionTable.PSVersion + ' langmode=' + $ExecutionContext.SessionState.LanguageMode)
L ('isadmin = ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
try { Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' } | ForEach-Object { L ('ip = ' + $_.IPAddress + '/' + $_.PrefixLength + ' if=' + $_.InterfaceAlias) } } catch {}

# 1) 网络配置文件改成 Private（Public 会把 WinRM 防火墙规则默认限制成本地子网）
try {
  Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object {
    L ('profile ' + $_.InterfaceAlias + ': ' + $_.NetworkCategory)
    try { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private -ErrorAction Stop; L '  -> Private OK' } catch { L ('  -> set fail: ' + $_.Exception.Message) }
  }
} catch { L ('profile step fail: ' + $_.Exception.Message) }

# 2) WinRM
try { Enable-PSRemoting -SkipNetworkProfileCheck -Force -ErrorAction Stop; L 'Enable-PSRemoting OK' } catch { L ('Enable-PSRemoting fail: ' + $_.Exception.Message) }
& netsh advfirewall firewall delete rule name="WinRM-HTTP-Any" | Out-Null
& netsh advfirewall firewall delete rule name="WinRM-HTTPS-Any" | Out-Null
& netsh advfirewall firewall add rule name="WinRM-HTTP-Any" dir=in action=allow protocol=TCP localport=5985 | Out-Null
& netsh advfirewall firewall add rule name="WinRM-HTTPS-Any" dir=in action=allow protocol=TCP localport=5986 | Out-Null
& winrm set winrm/config/service/auth '@{Basic="true"}' | Out-Null
& winrm set winrm/config/service '@{AllowUnencrypted="true"}' | Out-Null
& winrm set winrm/config/client '@{TrustedHosts="*"}' | Out-Null
try { Set-Item WSMan:\localhost\Service\AllowUnencrypted -Value $true -Force } catch {}
try { Set-Item WSMan:\localhost\Service\Auth\Basic -Value $true -Force } catch {}
try { Set-Item WSMan:\localhost\Client\TrustedHosts -Value '*' -Force } catch {}
try { Set-NetFirewallRule -Name 'WINRM-HTTP-In-TCP*' -Enabled True -Profile Any -RemoteAddress Any -ErrorAction SilentlyContinue } catch {}
try { Set-NetFirewallRule -DisplayGroup 'Windows Remote Management' -Enabled True -Profile Any -RemoteAddress Any -ErrorAction SilentlyContinue } catch {}
try { Get-Service WinRM | Set-Service -StartupType Automatic; Start-Service WinRM -ErrorAction SilentlyContinue } catch {}
$svc = Get-Service WinRM
L ('winrm svc = ' + $svc.Status + ' / ' + $svc.StartType)
L ('winrm listeners = ' + (((& winrm enumerate winrm/config/listener) -join ' | ') -replace '\s+', ' '))
L ('fw 5985 = ' + ((((& netsh advfirewall firewall show rule name="WinRM-HTTP-Any") | Select-String 'Enabled|LocalPort|RemoteIP') -join ' ; ') -replace '\s+', ' '))

# 3) 外网可达性探测（决定后面 GitHub 直拉 还是 本地中转）
$probe = @(
  'https://raw.githubusercontent.com/zhouxiaojin168/yunshudu/main/README.md',
  'https://nodejs.org/dist/index.json',
  'https://registry.npmmirror.com/-/ping',
  'https://github.com',
  'https://npmmirror.com/mirrors/node/index.json'
)
foreach ($u in $probe) {
  try { $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 12 -Method Head; L ('net ' + $u + ' -> ' + $r.StatusCode) }
  catch { L ('net ' + $u + ' -> FAIL ' + $_.Exception.Message) }
}

# 4) 环境盘点
try { L ('diskC free = ' + [math]::Round((Get-PSDrive C).Free / 1GB, 2) + ' GB') } catch {}
try { L ('cpu = ' + (Get-CimInstance Win32_Processor).Name + ' cores=' + (Get-CimInstance Win32_Processor).NumberOfLogicalProcessors) } catch {}
try { L ('ram = ' + [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 2) + ' GB') } catch {}
try { L ('git = ' + ((& git --version) -join '')) } catch { L 'git = none' }
try { L ('node = ' + ((& node --version) -join '')) } catch { L 'node = none' }
try { L ('powershell7 = ' + ((& pwsh -Version) -join '')) } catch { L 'pwsh = none' }
try { L ('wsmancfg = ' + ((& winrm get winrm/config/service) -join ' ')) } catch {}
L '=== DONE ==='
Set-Content -LiteralPath (Join-Path $Root 'bootstrap.done') -Value (Get-Date -Format o) -Encoding UTF8
