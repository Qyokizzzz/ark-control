@echo off
cd /d "%~dp0"
where pnpm >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js and pnpm first. See README.md.
  pause
  exit /b 1
)
if not exist node_modules (
  call pnpm install
  if errorlevel 1 exit /b 1
)
if not exist ".env.prod" if not exist ".env" if not defined ARK_ENV_FILE (
  call pnpm run setup:prod
  if errorlevel 1 exit /b 1
)
call pnpm build
if errorlevel 1 exit /b 1
call pnpm start
