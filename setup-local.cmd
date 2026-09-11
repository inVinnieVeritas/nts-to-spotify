@echo off
setlocal DisableDelayedExpansion
set "NTS2S_DIR=%~dp0"
if "%NTS2S_DIR:~0,2%"=="\\" (
	echo UNC installations are not supported. Use a local directory.
	exit /b 1
)
cd /d "%~dp0" >nul 2>&1
if errorlevel 1 (
	echo Could not select the installation directory. Nothing was started.
	exit /b 1
)
if defined NODE_OPTIONS (
	echo Remove inherited NODE_OPTIONS before running this wrapper. System CAs are configured automatically.
	exit /b 78
)
if defined NODE_TLS_REJECT_UNAUTHORIZED (
	echo Remove inherited NODE_TLS_REJECT_UNAUTHORIZED before running this wrapper. TLS verification must remain enabled.
	exit /b 78
)

where node >nul 2>nul
if errorlevel 1 (
	echo Node.js was not found. Install Node 24 LTS, then run this setup again.
	exit /b 64
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
	echo npm was not found. Install Node 24 LTS with npm, then run this setup again.
	exit /b 64
)

node scripts\start-local.mjs --check-node
set "NTS2S_EXIT_CODE=%errorlevel%"
if not "%NTS2S_EXIT_CODE%"=="0" exit /b %NTS2S_EXIT_CODE%

node -e "process.exit(process.allowedNodeEnvironmentFlags.has('--use-system-ca') ? 0 : 1)"
if not errorlevel 1 set "NODE_OPTIONS=--use-system-ca"

node scripts\start-local.mjs --setup-env
set "NTS2S_EXIT_CODE=%errorlevel%"
if not "%NTS2S_EXIT_CODE%"=="0" exit /b %NTS2S_EXIT_CODE%

call npm.cmd ci
set "NTS2S_EXIT_CODE=%errorlevel%"
if not "%NTS2S_EXIT_CODE%"=="0" (
	echo Dependency installation failed. No server was started.
	exit /b %NTS2S_EXIT_CODE%
)

call npm.cmd run build
set "NTS2S_EXIT_CODE=%errorlevel%"
if not "%NTS2S_EXIT_CODE%"=="0" (
	echo Production build failed. No server was started.
	exit /b %NTS2S_EXIT_CODE%
)

echo Setup complete. Edit .env if needed, then run start-local.cmd.
exit /b 0
