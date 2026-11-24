@echo off
cd /d "%~dp0"
call pnpm --filter @ark-control/agent start -- %*
set "ARK_AGENT_EXIT=%errorlevel%"
if not "%ARK_AGENT_EXIT%"=="0" pause
exit /b %ARK_AGENT_EXIT%
