@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

set "VM_HOST=136.112.61.134"
set "VM_USER=official_felixmunyany"
set "VM_KEY=%USERPROFILE%\.ssh\joyland_github_actions"
set "VM_DIR=~/portal"

echo.
echo ============================================================
echo  JOYLAND PORTAL DEPLOY
echo ============================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git is not available in PATH.
  pause
  exit /b 1
)

where ssh >nul 2>nul
if errorlevel 1 (
  echo [ERROR] SSH is not available in PATH.
  pause
  exit /b 1
)

if not exist "%VM_KEY%" (
  echo [ERROR] VM SSH key not found:
  echo         %VM_KEY%
  pause
  exit /b 1
)

for /f %%i in ('git status --porcelain') do set "HAS_CHANGES=1"

if defined HAS_CHANGES (
  echo Local changes found.
  echo.
  git status --short
  echo.
  set /p COMMIT_MSG=Commit message: 
  if "!COMMIT_MSG!"=="" set "COMMIT_MSG=Update portal"

  echo.
  echo [1/4] Committing local changes...
  git add .
  git commit -m "!COMMIT_MSG!"
  if errorlevel 1 (
    echo [ERROR] Commit failed.
    pause
    exit /b 1
  )
) else (
  echo No local changes to commit.
)

echo.
echo [2/4] Pushing to GitHub...
git push
if errorlevel 1 (
  echo [ERROR] Git push failed.
  pause
  exit /b 1
)

echo.
echo [3/4] Updating the Google Cloud VM...
ssh -i "%VM_KEY%" -o IdentitiesOnly=yes %VM_USER%@%VM_HOST% "cd %VM_DIR% && git pull && npm install && node --check server.js && node --check database.js && for f in routes/*.js; do node --check $f; done && pm2 restart joyland-portal"
if errorlevel 1 (
  echo [ERROR] VM deploy failed.
  pause
  exit /b 1
)

echo.
echo [4/4] Done.
echo.
echo Live portal:
echo   http://136.112.61.134
echo   http://136.112.61.134/admin
echo   http://136.112.61.134/app/
echo.
pause
