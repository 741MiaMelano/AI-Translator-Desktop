@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ============================================================
rem  Launch order:
rem    1) AI-Translator-Desktop.exe            downloaded release bundle
rem    2) release\AI-Translator-Desktop.exe    local source-tree build
rem    3) .portable\AI-Translator-Desktop.exe  legacy local download
rem    4) open the private GitHub Release page for a signed-in user
rem
rem  The local build is NOT SHA-256 checked: it is produced from this
rem  source tree, so the official release hash can never match it.
rem  The official path keeps its original verification.
rem
rem  Rebuild the local one with:  pnpm run package:portable
rem
rem  NOTE: keep this file ASCII-only. cmd.exe reads .bat in the OEM
rem  code page, so UTF-8 comments get split into garbage commands.
rem ============================================================

set "PORTABLE_NAME=AI-Translator-Desktop.exe"
set "PORTABLE_DIR=%~dp0.portable"
set "PORTABLE_EXE=%PORTABLE_DIR%\%PORTABLE_NAME%"
set "RELEASE_PAGE=https://github.com/741MiaMelano/AI-Translator-Desktop/releases/tag/v1.0.2-rc.6"
set "PORTABLE_SHA256=4d1fcbf7d2d252f50ec4b7f45cea10ae8e1199e202f89a40c1fbe41f418383bf"
set "LOCAL_DIR=%~dp0release"

rem ---- 1) release bundle beside this launcher ----
if exist "%~dp0%PORTABLE_NAME%" (
  set "PORTABLE_EXE=%~dp0%PORTABLE_NAME%"
  goto verify
)

rem ---- 2) local source-tree build ----
set "LOCAL_EXE="
for /f "delims=" %%F in ('dir /b /a-d /o-d "%LOCAL_DIR%\AI-Translator-Desktop.exe" 2^>nul') do (
  set "LOCAL_EXE=%LOCAL_DIR%\%%F"
  goto local_found
)
goto official

:local_found
echo [Desktop AI Translator] Launching the LOCAL build:
echo     %LOCAL_EXE%
echo     Built from this source tree; the official SHA-256 pin does not apply.
echo     Rebuild with: pnpm run package:portable
echo.
if /I "%PORTABLE_VERIFY_ONLY%"=="1" exit /b 0
start "" "%LOCAL_EXE%"
exit /b 0

rem ---- 3) / 4) legacy download: verify if present, otherwise open Release ----
:official
if exist "%PORTABLE_EXE%" goto verify

echo [Desktop AI Translator] No portable executable was found.
echo [Desktop AI Translator] Opening the private GitHub Release page.
echo Download %PORTABLE_NAME% while signed in, then run it directly.
start "" "%RELEASE_PAGE%"
exit /b 1

:verify
echo [Desktop AI Translator] Verifying SHA-256 of the official build...
powershell -NoProfile -Command "$stream=[System.IO.File]::OpenRead($env:PORTABLE_EXE); $sha=[System.Security.Cryptography.SHA256]::Create(); try { $actual=([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }; if ($actual -ne $env:PORTABLE_SHA256) { Write-Error ('SHA-256 mismatch: ' + $actual); exit 1 }"
if errorlevel 1 goto hash_failed

if /I "%PORTABLE_VERIFY_ONLY%"=="1" exit /b 0
echo [Desktop AI Translator] Launching the OFFICIAL v1.0.2-rc.6 build...
start "" "%PORTABLE_EXE%"
exit /b 0

:hash_failed
echo.
echo Verification failed. The application was not started. Delete .portable and retry.
echo If you meant to run your own build, run "pnpm run package:portable" first.
pause
exit /b 1
