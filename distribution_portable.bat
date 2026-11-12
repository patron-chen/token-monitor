@echo off
setlocal EnableExtensions
chcp 65001 >nul
pushd "%~dp0" || exit /b 1

set "EXIT_CODE=0"
set "PORTABLE_ONLY=0"
set "SKIP_CHECKS=0"

:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--portable-only" (
  set "PORTABLE_ONLY=1"
  shift
  goto :parse_args
)
if /I "%~1"=="--skip-checks" (
  set "SKIP_CHECKS=1"
  shift
  goto :parse_args
)
if /I "%~1"=="--help" goto :usage
if /I "%~1"=="-h" goto :usage
echo [ERROR] Unknown option: %~1
set "EXIT_CODE=1"
goto :cleanup

:usage
echo Usage: distribution_portable.bat [--portable-only] [--skip-checks]
echo.
echo Runs the standard Windows x64 release build ^(NSIS installer + Portable exe^)
echo matching package.json "dist:win" and .github/workflows/release.yml preflight checks.
echo.
echo Options:
echo   --portable-only  Build only the portable .exe instead of NSIS + portable
echo   --skip-checks    Skip sync:worker --check and eslint preflight checks
goto :cleanup

:args_done
for /f "usebackq delims=" %%V in (`node -p "require('./package.json').version" 2^>nul`) do set "APP_VERSION=%%V"
if not defined APP_VERSION (
  echo [ERROR] Failed to read package.json version. Ensure Node.js ^>=22.15.0 is on PATH.
  set "EXIT_CODE=1"
  goto :cleanup
)

:: Enforce package.json engines.node (>=22.15.0) before running toolchain scripts.
node -e "const semver = require('semver'); const pkg = require('./package.json'); if (!semver.satisfies(process.version, pkg.engines.node)) { console.error('[ERROR] Node ' + process.version + ' does not satisfy ' + pkg.engines.node); process.exit(1); }"
if errorlevel 1 goto :fail

:: Bail early only if a process is running out of dist\, avoiding false positives from an installed copy elsewhere.
powershell -NoProfile -Command "$dist = Resolve-Path 'dist' -ErrorAction SilentlyContinue; if ($dist) { $hit = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dist.Path, [System.StringComparison]::OrdinalIgnoreCase) }; if ($hit) { exit 1 } }"
if errorlevel 1 (
  echo [ERROR] A process under dist\ is currently running. Quit it and retry.
  set "EXIT_CODE=1"
  goto :cleanup
)

echo === Token Monitor v%APP_VERSION% Standard Windows Release Build ===

if "%SKIP_CHECKS%"=="0" (
  echo [1/6] Checking worker/shared module sync...
  call npm run sync:worker -- --check
  if errorlevel 1 goto :fail

  echo [2/6] Running ESLint...
  call npm run lint
  if errorlevel 1 goto :fail
) else (
  echo [1-2/6] Skipping sync:worker and ESLint checks ^(--skip-checks^).
)

echo [3/6] Ensuring pinned vendored tokscale ^(win32-x64^)...
call npm run ensure:tokscale -- --platform=win32-x64
if errorlevel 1 goto :fail

echo [4/6] Verifying vendored tokscale client compatibility...
node scripts/verify-vendored-tokscale-clients.js
if errorlevel 1 goto :fail

echo [5/6] Verifying Electron packaging version...
node -e "const config = require('./scripts/electron-builder.config.js'); const installed = require('electron/package.json').version; const effective = config.electronVersion || installed; console.log('Electron packaging version:', effective, '(installed:', installed + ')'); if (effective !== installed) throw new Error('Electron version mismatch: expected ' + installed + ', got ' + effective);"
if errorlevel 1 goto :fail

if "%PORTABLE_ONLY%"=="1" (
  echo [6/6] Packaging Windows x64 portable executable only...
  call npx --no-install electron-builder --win portable --x64 --publish never
  if errorlevel 1 goto :fail
) else (
  echo [6/6] Running standard Windows x64 release build ^(dist:win: NSIS + Portable^)...
  call npm run dist:win
  if errorlevel 1 goto :fail

  echo [Post] Verifying release updater metadata and artifact names...
  call npm run verify:release-artifact-names
  if errorlevel 1 goto :fail
)

set "PORTABLE_EXE=dist\Token-Monitor-%APP_VERSION%.exe"
set "SETUP_EXE=dist\Token-Monitor-Setup-%APP_VERSION%.exe"
set "DOCK_HELPER=dist\win-unpacked\resources\windows-dock\TokenMonitor.DockBackdrop.exe"
set "UNPACKED_TOKSCALE=dist\win-unpacked\resources\app.asar.unpacked\node_modules\@tokscale\cli-win32-x64-msvc\bin\tokscale.exe"

if not exist "%PORTABLE_EXE%" (
  echo [ERROR] Expected portable artifact missing: %PORTABLE_EXE%
  set "EXIT_CODE=1"
  goto :cleanup
)
if "%PORTABLE_ONLY%"=="0" if not exist "%SETUP_EXE%" (
  echo [ERROR] Expected NSIS installer artifact missing: %SETUP_EXE%
  set "EXIT_CODE=1"
  goto :cleanup
)
if not exist "%DOCK_HELPER%" (
  echo [ERROR] Expected Windows dock helper missing: %DOCK_HELPER%
  set "EXIT_CODE=1"
  goto :cleanup
)
if not exist "%UNPACKED_TOKSCALE%" (
  echo [ERROR] Expected vendored tokscale binary missing: %UNPACKED_TOKSCALE%
  set "EXIT_CODE=1"
  goto :cleanup
)

echo.
echo [OK] Release build succeeded:
if "%PORTABLE_ONLY%"=="0" echo   Installer: %CD%\%SETUP_EXE%
echo   Portable : %CD%\%PORTABLE_EXE%
goto :cleanup

:fail
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo [ERROR] Release build failed with exit code %EXIT_CODE%.

:cleanup
popd
endlocal & exit /b %EXIT_CODE%
