param([switch]$Run)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$Node = Join-Path $PSScriptRoot 'runtime\node.exe'
$Entry = Join-Path $PSScriptRoot 'agent\main.cjs'
$PackageSettings = Join-Path $PSScriptRoot 'ArkHostAgent.json'
$Config = Join-Path $PSScriptRoot 'state\config.json'
$Log = Join-Path $PSScriptRoot 'state\agent.log'

function Invoke-HostAgent([string[]]$AgentParameters, [string]$EnrollmentCode) {
  if ((Test-Path -LiteralPath $Log) -and (Get-Item -LiteralPath $Log).Length -gt 5MB) {
    Move-Item -LiteralPath $Log -Destination "$Log.previous" -Force
  }
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Log))
  if (-not (Test-Path -LiteralPath $Log)) {
    Add-Content -LiteralPath $Log -Encoding UTF8 -Value 'ARK Control Host Agent'
  }
  # Windows PowerShell treats native stderr as ErrorRecord. Capture the output and
  # preserve the exit code so enrollment failures stay visible in the console.
  $ErrorActionPreference = 'Continue'
  & {
    if ($AgentParameters -contains '--code-stdin') { $EnrollmentCode | & $Node @AgentParameters }
    else { & $Node @AgentParameters }
  } 2>&1 | ForEach-Object {
    $AgentLine = $_.ToString()
    Add-Content -LiteralPath $Log -Value $AgentLine -ErrorAction Stop
    if (-not $Run) { Write-Host $AgentLine }
  }
  $AgentExitCode = $LASTEXITCODE
  if ($AgentExitCode -ne 0) {
    $ExitMessage = "主机助手退出（退出码 $AgentExitCode）。日志：$Log"
    Add-Content -LiteralPath $Log -Value $ExitMessage -ErrorAction Stop
    if (-not $Run) { Write-Host $ExitMessage -ForegroundColor Red }
  }
  return $AgentExitCode
}

$Sha = [Security.Cryptography.SHA256]::Create()
$Key = [BitConverter]::ToString($Sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Config.ToLowerInvariant()))).Replace('-', '').Substring(0, 20)
$Sha.Dispose()
$Task = "ArkHostAgent-$Key"
$Mutex = New-Object Threading.Mutex($false, "Local\$Task")
$Owned = $false
try {
  try { $Owned = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $Owned = $true }
  if (-not $Owned) {
    Write-Host '此目录下的主机助手已在运行。'
    return
  }
  if (-not (Test-Path -LiteralPath $Node) -or -not (Test-Path -LiteralPath $Entry)) { throw '请先完整解压主机助手安装包。' }
  $Configured = Test-Path -LiteralPath $Config
  if ($Run) {
    if (-not $Configured) { throw '请先运行 ArkHostAgent.cmd 接入主机。' }
    exit (Invoke-HostAgent @($Entry, '--config', $Config))
  }
  if ($Configured) {
    Write-Host '1  启动助手'
    Write-Host '2  使用新接入码连接'
    Write-Host '3  设置为 Windows 用户登录后自动启动'
    Write-Host '4  关闭自动启动'
    $Choice = Read-Host '请选择 [1]'
  } else { $Choice = '2' }
  if ($Choice -eq '3') {
    $User = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $Action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Run' -f $PSCommandPath) -WorkingDirectory $PSScriptRoot
    $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $Settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $Task -Action $Action -Principal $Principal -Trigger $Trigger -Settings $Settings -Description '方舟控制台主机助手' -Force | Out-Null
    Write-Host "已设置自动启动。后台日志位于 $Log"
    return
  }
  if ($Choice -eq '4') {
    if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $Task -Confirm:$false
    }
    Write-Host '已关闭此目录的自动启动。'
    return
  }
  if ($Choice -eq '2') {
    $Old = if ($Configured) { Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json } else { $null }
    $PackagedAddress = if (Test-Path -LiteralPath $PackageSettings -PathType Leaf) {
      [string](Get-Content -LiteralPath $PackageSettings -Raw -Encoding UTF8 | ConvertFrom-Json).apiUrl
    } else { '' }
    $Address = if ($PackagedAddress) { $PackagedAddress }
      elseif ($Old) { $Old.apiUrl }
      else { (Read-Host '管理后台地址（含协议）').Trim() }
    $Uri = $null
    if (-not [Uri]::TryCreate($Address, [UriKind]::Absolute, [ref]$Uri) -or $Uri.Scheme -notin @('https', 'http') -or -not $Uri.Host -or $Uri.UserInfo) { throw '管理后台地址格式无效，请从控制台重新下载助手。' }
    $Dir = if ($Old) { $Old.root } else { Join-Path $PSScriptRoot 'game-data' }
    $NewDir = (Read-Host "游戏工作目录 [$Dir]").Trim('"', ' ')
    if ($NewDir) { $Dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($NewDir) }
    $AgentArguments = @($Entry, '--config', $Config, '--enroll', $Address, '--root', $Dir, '--code-stdin', '--enroll-only')
    if ($Uri.Scheme -eq 'http' -and -not $Uri.IsLoopback) {
      if (-not $PackagedAddress -and -not ($Old -and $Old.allowHttp) -and
          (Read-Host '确认这是可信内网请输入 YES') -cne 'YES') { return }
      $AgentArguments += '--allow-http'
    }
    $Secure = Read-Host '一次性接入码' -AsSecureString
    $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { $EnrollExit = Invoke-HostAgent $AgentArguments ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer); $Secure.Dispose() }
    if ($EnrollExit -ne 0) { exit $EnrollExit }
  } elseif ($Choice -and $Choice -ne '1') { throw '无效的选项。' }
  exit (Invoke-HostAgent @($Entry, '--config', $Config))
} catch {
  $AgentError = $_.Exception.Message
  if (Test-Path -LiteralPath $Log) { Add-Content -LiteralPath $Log -Value $AgentError -ErrorAction SilentlyContinue }
  Write-Host $AgentError -ForegroundColor Red
  exit 1
} finally {
  if ($Owned) { $Mutex.ReleaseMutex() }
  $Mutex.Dispose()
}
