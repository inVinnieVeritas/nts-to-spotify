@echo off
setlocal DisableDelayedExpansion
rem Prevent an inherited ERRORLEVEL variable from shadowing cmd's numeric exit status.
set "ERRORLEVEL="
set "NTS2S_DIR=%~dp0"
if "%NTS2S_DIR:~0,2%"=="\\" (
	echo UNC installations are not supported. Use a local directory.
	set "NTS2S_EXIT_CODE=1"
	goto :NTS2S_FINISH
)
cd /d "%~dp0" >nul 2>&1
if errorlevel 1 (
	echo Could not select the installation directory. Nothing was started.
	set "NTS2S_EXIT_CODE=1"
	goto :NTS2S_FINISH
)
if defined NODE_OPTIONS (
	echo Remove inherited NODE_OPTIONS before running this wrapper. System CAs are configured automatically.
	set "NTS2S_EXIT_CODE=78"
	goto :NTS2S_FINISH
)
if defined NODE_TLS_REJECT_UNAUTHORIZED (
	echo Remove inherited NODE_TLS_REJECT_UNAUTHORIZED before running this wrapper. TLS verification must remain enabled.
	set "NTS2S_EXIT_CODE=78"
	goto :NTS2S_FINISH
)

where node >nul 2>nul
if errorlevel 1 (
	echo Node.js was not found. Install Node 24 LTS, then try again.
	set "NTS2S_EXIT_CODE=64"
	goto :NTS2S_FINISH
)

node scripts\start-local.mjs
set "NTS2S_EXIT_CODE=%errorlevel%"
goto :NTS2S_FINISH

:NTS2S_FINISH
if "%NTS2S_EXIT_CODE%"=="0" exit /b 0
if defined CI exit /b %NTS2S_EXIT_CODE%
if defined TF_BUILD exit /b %NTS2S_EXIT_CODE%
call :NTS2S_IS_EXPLORER_LAUNCH
if not "%errorlevel%"=="0" exit /b %NTS2S_EXIT_CODE%
echo(
echo Press any key to close this window.
pause >nul
exit /b %NTS2S_EXIT_CODE%

:NTS2S_IS_EXPLORER_LAUNCH
set "NTS2S_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%NTS2S_POWERSHELL%" exit /b 1
"%NTS2S_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -Command "try { if ([Console]::IsInputRedirected) { exit 1 }; $self = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID) -OperationTimeoutSec 1 -ErrorAction Stop; $shell = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $self.ParentProcessId) -OperationTimeoutSec 1 -ErrorAction Stop; if ($shell.Name -ine 'cmd.exe' -or $shell.CreationDate -gt $self.CreationDate) { exit 1 }; $transient = $shell.CommandLine -match '(?i)^(?:[^\s]+|\x22[^\x22]+\x22)\s+(?:(?:/d|/s|/q|/a|/u|/v:(?:on|off)|/e:(?:on|off))\s+)*/c(?=\s|\x22|$)'; if (-not $transient) { exit 1 }; $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $shell.ParentProcessId) -OperationTimeoutSec 1 -ErrorAction Stop; if ($parent.Name -ieq 'explorer.exe' -and $parent.CreationDate -le $shell.CreationDate) { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %errorlevel%
