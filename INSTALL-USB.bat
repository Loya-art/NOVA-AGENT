@echo off
chcp 65001 >nul
title NOVA Agent - Install to USB
setlocal EnableDelayedExpansion

REM ============================================================
REM  NOVA Agent - install this folder onto a USB / removable drive
REM  Asks for a target drive letter, copies everything (exFAT OK),
REM  then creates a desktop shortcut with the Nian-beast icon.
REM ============================================================

pushd "%~dp0"
set "ROOT=%CD%"
popd
set "NODE_BIN=%ROOT%\runtime\node\bin"

if not exist "%NODE_BIN%\node.exe" (
    echo [ERROR] Portable Node not found. The "runtime" folder must sit next to this script.
    pause
    exit /b 1
)

echo.
echo  ============================================================
echo    NOVA Agent - install to USB drive
echo  ============================================================
echo.
echo    This copies the whole app (~600 MB with the bundled Node
echo    runtime) to a removable drive, then makes a desktop
echo    shortcut pointing at that drive.
echo.
set /p "TARGET=Target drive letter (e.g. E): "
if not defined TARGET (
    echo [ERROR] No drive letter given.
    pause
    exit /b 1
)
set "TARGET=%TARGET:~0,1%"
if not exist "%TARGET%:\" (
    echo [ERROR] Drive %TARGET%:\ not found or not ready.
    pause
    exit /b 1
)

set "DEST=%TARGET%:\NOVA-Agent"
echo.
echo  Copying "%ROOT%" --^> "%DEST%" ...
echo  (excluded: logs, caches, git, release artifacts)
echo.

robocopy "%ROOT%" "%DEST%" /E /NFL /NDL /NJH /NJS ^
  /XD logs .git release dist ".tmp-vault-test" node_modules\.cache ^
  /XF "*.log" "npm-debug.log*"

if errorlevel 8 (
    echo.
    echo [ERROR] Copy failed (robocopy exit %errorlevel%). Check disk space / write protection.
    pause
    exit /b 1
)

echo.
echo  Copy done. Creating desktop shortcut with the Nian icon...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\make-shortcut.ps1" -TargetDir "%DEST%" 2>nul
if errorlevel 1 echo  [WARN] Shortcut not created - you can still start from %DEST%\NOVA-AGENT.bat

echo.
echo  ============================================================
echo    Installed to %DEST%
echo    Unplug safely, plug into any x64 Windows PC and
echo    double-click %TARGET%:\NOVA-Agent\NOVA-AGENT.bat
echo    (or the desktop shortcut)
echo  ============================================================
echo.
pause
endlocal
