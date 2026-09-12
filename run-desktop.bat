@echo off
setlocal

pushd "%~dp0"

set "PACKAGE_RUNNER="
set "PACKAGE_MODE=bundled"
set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
set "BUNDLED_PNPM=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"

if exist "%BUNDLED_NODE%\node.exe" if exist "%BUNDLED_PNPM%" (
  set "PATH=%BUNDLED_NODE%;%PATH%"
  set "PACKAGE_RUNNER=%BUNDLED_PNPM%"
)

if not defined PACKAGE_RUNNER (
  set "PACKAGE_MODE=npm"
  for /f "delims=" %%N in ('where npm 2^>nul') do (
    if not defined PACKAGE_RUNNER set "PACKAGE_RUNNER=%%N"
  )
)

if not exist "package.json" (
  echo Missing package.json. Run this launcher from the Sign99RTS repository root.
  goto error
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not on PATH.
  echo Install Node.js 18 or newer from https://nodejs.org/ and run this file again.
  goto error
)

if not defined PACKAGE_RUNNER (
  echo npm or pnpm is required but neither was found.
  echo Install Node.js 18 or newer with npm enabled, then run this file again.
  goto error
)

for /f "tokens=1 delims=." %%A in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%A"
if %NODE_MAJOR% LSS 18 (
  echo Node.js 18 or newer is required. Detected:
  node --version
  echo Install a current Node.js LTS from https://nodejs.org/ and run this file again.
  goto error
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call "%PACKAGE_RUNNER%" install
  if errorlevel 1 goto error
)

if not exist "node_modules\.bin\electron.cmd" (
  echo Electron is missing. Repairing dependencies...
  call "%PACKAGE_RUNNER%" install
  if errorlevel 1 goto error
)

if not exist "node_modules\.bin\tsx.cmd" (
  echo LAN helper runtime is missing. Repairing dependencies...
  call "%PACKAGE_RUNNER%" install
  if errorlevel 1 goto error
)

echo Starting Sign99RTS desktop build...
if "%PACKAGE_MODE%"=="bundled" (
  node scripts\scan-music.mjs
  if errorlevel 1 goto error
  node node_modules\typescript\bin\tsc --noEmit
  if errorlevel 1 goto error
  node node_modules\vite\bin\vite.js build
  if errorlevel 1 goto error
  node node_modules\typescript\bin\tsc --project tsconfig.server.json
) else (
  call "%PACKAGE_RUNNER%" run build
)
if errorlevel 1 goto error

echo Launching Sign99RTS desktop with LAN helper auto-start enabled...
set "SIGN99_AUTO_START_LAN_HELPER=1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%CD%\node_modules\.bin\electron.cmd' -ArgumentList @('electron\main.cjs') -WorkingDirectory '%CD%' -WindowStyle Hidden"
if errorlevel 1 goto error

timeout /t 1 /nobreak >nul
popd
exit /b 0

:error
echo.
echo Sign99RTS desktop launch failed. Check the error above.
popd
pause
exit /b 1
