@echo off
chcp 65001 >nul
title NOVA Agent - Setup
setlocal EnableDelayedExpansion

REM ============================================================
REM  NOVA Agent - reconfigure API key / provider / model routing
REM  Deletes stored credentials and re-runs the first-run wizard.
REM ============================================================

pushd "%~dp0"
set "ROOT=%CD%"
popd
set "NODE_BIN=%ROOT%\runtime\node\bin"

if not exist "%NODE_BIN%\node.exe" (
    echo [ERROR] Portable Node not found: %NODE_BIN%\node.exe
    pause
    exit /b 1
)

"%NODE_BIN%\node.exe" "%ROOT%\app\vault.mjs" reset
echo.
pause
