@echo off
setlocal
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0ArkHostAgent.ps1"
set "ARK_HOST_EXIT=%ERRORLEVEL%"
if "%ARK_HOST_EXIT%"=="0" exit /b 0
echo.
echo Ark Host Agent exit code: %ARK_HOST_EXIT%
echo Log: "%~dp0state\agent.log"
pause
exit /b %ARK_HOST_EXIT%
