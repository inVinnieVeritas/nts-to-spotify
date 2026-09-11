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
	echo Node.js was not found. Install Node 24 LTS, then try again.
	exit /b 64
)

node scripts\start-local.mjs
set "NTS2S_EXIT_CODE=%errorlevel%"
exit /b %NTS2S_EXIT_CODE%
