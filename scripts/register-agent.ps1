param(
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$TaskName = 'ArkControlAgent'
)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
$taskEntry = Join-Path $taskRoot 'apps\agent\dist\main.js'
if (-not (Test-Path -LiteralPath $taskEntry)) { throw '请先运行 pnpm build。' }
if ($taskConfig.Contains('"') -or $taskEntry.Contains('"')) { throw '路径不能包含双引号。' }
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskArguments = '"{0}" --config "{1}"' -f $taskEntry, $taskConfig
$taskAction = New-ScheduledTaskAction -Execute $taskNode -Argument $taskArguments -WorkingDirectory $taskRoot
$taskTrigger = New-ScheduledTaskTrigger -AtStartup
$taskSettings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType S4U -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Principal $taskPrincipal -Description '方舟控制台主机助手' | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output '主机助手已注册为开机任务。'
