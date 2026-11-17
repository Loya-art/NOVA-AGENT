@echo off
chcp 65001 >nul
title NOVA Agent
setlocal EnableDelayedExpansion

REM ============================================================
REM  NOVA Agent - portable launcher (double-click entry point)
REM  Drive-letter adaptive: everything is resolved from this
REM  script's own directory, so it works on any drive / any path.
REM ============================================================

pushd "%~dp0"
set "ROOT=%CD%"
popd
set "NODE_BIN=%ROOT%\runtime\node\bin"

set "DSH_HOME=%ROOT%\data"
set "DSH_DESKTOP_CWD=%ROOT%\workspace"
REM No-sandbox mode: agent runs commands without asking, may write outside workspace.
REM Delete the next line to restore default (workspace-write + per-step approval).
set "DSH_PERMISSION_MODE=danger-full-access"
set "PATH=%NODE_BIN%;%PATH%"

if not exist "%NODE_BIN%\node.exe" (
    echo [ERROR] Portable Node not found: %NODE_BIN%\node.exe
    echo         The "runtime" folder must sit next to this script.
    pause
    exit /b 1
)

REM ---- credentials: first-run wizard + password unlock (app\vault.mjs) ----
REM NOVA_API_READY is printed by vault.mjs on success (provider-agnostic).
set "KEYTMP=%TEMP%\nova_agent_keys.tmp"
if defined NOVA_API_READY goto :keys_ready
if defined DEEPSEEK_API_KEY goto :keys_ready
if defined SILICONFLOW_API_KEY goto :keys_ready
if defined OPENAI_API_KEY goto :keys_ready

if not exist "%ROOT%\data\vault.enc" if not exist "%ROOT%\key.txt" goto :do_setup
goto :do_unlock

:do_setup
cls
echo.
echo  ============================================================
echo    NOVA Agent - first run detected
echo    No API key configured yet. Starting setup wizard...
echo    It only runs once: pick a provider, paste your key.
echo  ============================================================
echo.
"%NODE_BIN%\node.exe" "%ROOT%\app\vault.mjs" init > "%KEYTMP%"
if errorlevel 1 (
    del "%KEYTMP%" >nul 2>&1
    echo.
    echo [SETUP] wizard failed or was cancelled.
    pause
    exit /b 1
)
goto :capture

:do_unlock
"%NODE_BIN%\node.exe" "%ROOT%\app\vault.mjs" unlock > "%KEYTMP%"
if errorlevel 1 (
    del "%KEYTMP%" >nul 2>&1
    echo [LOCK] unlock failed.
    pause
    exit /b 1
)

:capture
for /f "usebackq tokens=1,* delims==" %%K in ("%KEYTMP%") do set "%%K=%%L"
del "%KEYTMP%" >nul 2>&1
if not defined NOVA_API_READY (
    echo [WARN] no API key found in credentials. Run SETUP.bat to configure.
)

:keys_ready
echo Starting NOVA Agent TUI...

REM ---- assemble long-term memory into data\AGENTS.md (frozen snapshot) ----
"%NODE_BIN%\node.exe" "%ROOT%\app\assemble-memory.mjs" >nul 2>&1

cd /d "%ROOT%\app"
"%NODE_BIN%\node.exe" "ui\bundle.mjs"

echo.
echo [EXITED] TUI closed.
pause
endlocal
