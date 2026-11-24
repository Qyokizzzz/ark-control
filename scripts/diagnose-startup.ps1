param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$GamePid
)

# Read-only: no process termination, configuration changes, downloads or network requests.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$taskSecrets = New-Object 'System.Collections.Generic.List[string]'
function Hide-PrivateText([string]$Text) {
  foreach ($taskSecret in $taskSecrets) {
    if ($taskSecret) { $Text = $Text.Replace($taskSecret, '[REDACTED]') }
  }
  $Text = [regex]::Replace($Text, '(?i)((?:ServerAdminPassword|ServerPassword|RCONPassword|appSecret|token)\s*[=:]\s*)[^\s?&;]+', '$1[REDACTED]')
  if ($Text.Length -gt 1000) { $Text = $Text.Substring(0, 1000) }
  return $Text
}

try {
  $taskGame = Get-Process -Id $GamePid -ErrorAction Stop
  $taskExecutable = $taskGame.Path
  if (-not $taskExecutable) { throw 'Cannot read executable path. Run this script as the user running the agent, or as administrator.' }
  if ([IO.Path]::GetFileName($taskExecutable) -ine 'ShooterGameServer.exe') {
    throw 'The supplied PID is not ShooterGameServer.exe. Check the current PID in the map details.'
  }
  $taskInstanceDirectory = $taskExecutable
  for ($taskIndex = 0; $taskIndex -lt 4; ++$taskIndex) {
    $taskInstanceDirectory = Split-Path -Parent $taskInstanceDirectory
  }
  $taskSaved = Join-Path $taskInstanceDirectory 'ShooterGame\Saved'
  $taskSettingsPath = Join-Path $taskSaved 'Config\WindowsServer\GameUserSettings.ini'
  $taskSettings = @()
  $taskRconPort = 27020
  if (Test-Path -LiteralPath $taskSettingsPath -PathType Leaf) {
    $taskSection = ''
    foreach ($taskLine in ([IO.File]::ReadAllText($taskSettingsPath) -split '\r?\n')) {
      if ($taskLine -match '^\s*\[([^]]+)\]') { $taskSection = $Matches[1] }
      elseif ($taskLine -match '^\s*(ServerAdminPassword|ServerPassword)\s*=(.*)$') {
        $taskValue = $Matches[2].Trim()
        if ($taskValue) { $taskSecrets.Add($taskValue) }
        if ($Matches[1] -ieq 'ServerAdminPassword') {
          $taskSettings += [ordered]@{ Section = $taskSection; Key = 'ServerAdminPassword'; Configured = [bool]$taskValue }
        }
      }
      elseif ($taskLine -match '^\s*(RCONEnabled|RCONPort)\s*=(.*)$') {
        $taskKey = $Matches[1]
        $taskValue = $Matches[2].Trim()
        $taskSettings += [ordered]@{ Section = $taskSection; Key = $taskKey; Value = $taskValue }
        if ($taskSection -ieq 'ServerSettings' -and $taskKey -ieq 'RCONPort' -and $taskValue -match '^\d+$') {
          $taskRconPort = [int]$taskValue
        }
      }
    }
  }
  $taskCpuStart = $taskGame.TotalProcessorTime.TotalSeconds
  $taskLaunchOptions = [ordered]@{ Readable = $false; AdminPasswordProvided = $null; RCONEnabled = $null; RCONPort = $null }
  try {
    $taskCommandLine = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $GamePid) -ErrorAction Stop).CommandLine
    if ($taskCommandLine) {
      $taskLaunchOptions.Readable = $true
      $taskLaunchPassword = [regex]::Match($taskCommandLine, '(?i)\?ServerAdminPassword=([^?\s"]+)')
      $taskLaunchOptions.AdminPasswordProvided = $taskLaunchPassword.Success -and $taskLaunchPassword.Groups[1].Value.Length -gt 0
      if ($taskLaunchPassword.Success) { $taskSecrets.Add($taskLaunchPassword.Groups[1].Value) }
      $taskLaunchEnabled = [regex]::Match($taskCommandLine, '(?i)\?RCONEnabled=([^?\s"]+)')
      if ($taskLaunchEnabled.Success) { $taskLaunchOptions.RCONEnabled = $taskLaunchEnabled.Groups[1].Value }
      $taskLaunchPort = [regex]::Match($taskCommandLine, '(?i)\?RCONPort=(\d+)')
      if ($taskLaunchPort.Success) { $taskLaunchOptions.RCONPort = [int]$taskLaunchPort.Groups[1].Value }
    }
  } catch { $taskLaunchOptions.ReadError = 'Process options unavailable. No command line is included in this report.' }
  Start-Sleep -Seconds 2
  $taskGame.Refresh()
  $taskCpuDelta = $taskGame.TotalProcessorTime.TotalSeconds - $taskCpuStart
  $taskTcpListeners = @()
  $taskUdpEndpoints = @()
  $taskPortErrors = @()
  $taskTcpAvailable = $true
  $taskUdpAvailable = $true
  $taskPortQueryMethod = 'CIM'
  try {
    $taskTcpListeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalPort -eq $taskRconPort -or $_.OwningProcess -eq $GamePid } |
      Select-Object LocalAddress, LocalPort, OwningProcess)
  } catch { $taskTcpAvailable = $false }
  try {
    $taskUdpEndpoints = @(Get-NetUDPEndpoint -ErrorAction Stop |
      Where-Object { $_.OwningProcess -eq $GamePid } |
      Select-Object LocalAddress, LocalPort, OwningProcess)
  } catch { $taskUdpAvailable = $false }
  if (-not $taskTcpAvailable -or -not $taskUdpAvailable) {
    $taskPortQueryMethod = 'CIM with netstat fallback'
    try {
      $taskPortLines = & (Join-Path $env:SystemRoot 'System32\netstat.exe') -ano
      if ($LASTEXITCODE -ne 0) { throw 'netstat did not complete successfully.' }
      foreach ($taskPortLine in $taskPortLines) {
        $taskParts = ([string]$taskPortLine).Trim() -split '\s+'
        if ($taskParts.Count -lt 4 -or $taskParts[0] -notin @('TCP', 'UDP')) { continue }
        $taskEndpoint = [regex]::Match($taskParts[1], '^(.*):(\d+)$')
        if (-not $taskEndpoint.Success -or $taskParts[-1] -notmatch '^\d+$') { continue }
        $taskOwner = [int]$taskParts[-1]
        $taskLocalPort = [int]$taskEndpoint.Groups[2].Value
        $taskPortEntry = [ordered]@{
          LocalAddress = $taskEndpoint.Groups[1].Value.Trim('[', ']')
          LocalPort = $taskLocalPort
          OwningProcess = $taskOwner
        }
        if (-not $taskTcpAvailable -and $taskParts[0] -eq 'TCP' -and
            $taskParts[2] -in @('0.0.0.0:0', '[::]:0') -and
            ($taskLocalPort -eq $taskRconPort -or $taskOwner -eq $GamePid)) {
          $taskTcpListeners += $taskPortEntry
        }
        if (-not $taskUdpAvailable -and $taskParts[0] -eq 'UDP' -and $taskOwner -eq $GamePid) {
          $taskUdpEndpoints += $taskPortEntry
        }
      }
    } catch {
      $taskPortErrors += 'Unable to enumerate ports with CIM or netstat. An empty list does not confirm the absence of listeners.'
    }
  }
  $taskLogs = @()
  foreach ($taskName in @('ArkControlProcess.log', 'ShooterGame.log')) {
    $taskLogPath = Join-Path $taskSaved ('Logs\' + $taskName)
    $taskLog = [ordered]@{ Path = $taskLogPath; Exists = $false }
    if (Test-Path -LiteralPath $taskLogPath -PathType Leaf) {
      $taskLogInfo = Get-Item -LiteralPath $taskLogPath
      $taskLog.Exists = $true
      $taskLog.SizeBytes = $taskLogInfo.Length
      $taskLog.ModifiedAt = $taskLogInfo.LastWriteTime.ToString('o')
      try {
        $taskLog.Tail = @(Get-Content -LiteralPath $taskLogPath -Encoding UTF8 -Tail 20 -ErrorAction Stop |
          ForEach-Object { Hide-PrivateText ([string]$_) })
      } catch { $taskLog.ReadError = 'Unable to read this log. Check file permissions or exclusive locks.' }
    }
    $taskLogs += $taskLog
  }
  [ordered]@{
    Note = 'Read-only diagnostic. Password values and command line are not included. Check the output before sharing.'
    Process = [ordered]@{
      PID = $GamePid
      Executable = $taskExecutable
      StartedAt = $taskGame.StartTime.ToString('o')
      MemoryMB = [math]::Round($taskGame.WorkingSet64 / 1MB, 1)
      CPUSecondsDuringTwoSeconds = [math]::Round($taskCpuDelta, 3)
      Responding = $taskGame.Responding
      WindowTitle = Hide-PrivateText $taskGame.MainWindowTitle
    }
    SettingsPath = $taskSettingsPath
    SettingsExist = Test-Path -LiteralPath $taskSettingsPath -PathType Leaf
    Settings = $taskSettings
    IniAdminPasswordConfigured = @($taskSettings | Where-Object { $_.Section -ieq 'ServerSettings' -and $_.Key -eq 'ServerAdminPassword' -and $_.Configured }).Count -gt 0
    LaunchOptions = $taskLaunchOptions
    RconPortFromSettings = $taskRconPort
    TCPListeners = $taskTcpListeners
    UDPEndpoints = $taskUdpEndpoints
    PortReadErrors = $taskPortErrors
    PortQueryMethod = $taskPortQueryMethod
    Logs = $taskLogs
  } | ConvertTo-Json -Depth 6
} catch {
  Write-Error ('Startup diagnostic failed: ' + $_.Exception.Message)
  exit 1
}
