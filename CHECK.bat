@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  Preflight check - run this FIRST on a new computer.
REM  Answers one question: can this PC run NOVA as-is?
REM  (No Node / Python install needed.)
REM  Read-only: writes nothing, no network, no tokens.
REM ============================================================
pushd "%~dp0"
set "ROOT=%CD%"
popd
set "NODE_BIN=%ROOT%\runtime\node\bin\node.exe"

if not exist "%NODE_BIN%" (
    echo.
    echo [ERROR] Portable Node not found: %NODE_BIN%
    echo         runtime\node is missing or the USB drive is write-protected.
    echo.
    pause
    exit /b 1
)

"%NODE_BIN%" "%ROOT%\tools\preflight.mjs"
echo.
pause
endlocal
