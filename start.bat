@echo off
setlocal EnableExtensions

if /i not "%~1"=="--run" (
    start "DARAJA PYTHON PORTAL" "%ComSpec%" /k ""%~f0" --run"
    exit /b
)

cd /d "%~dp0"
set "PORT=3000"
set "HOST=0.0.0.0"
set "URL=http://localhost:%PORT%/"

title DARAJA PYTHON PORTAL
color 0A
cls

echo.
echo ============================================================
echo      DARAJA PYTHON PORTAL
echo ============================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    color 0C
    echo [ERROR] Python is not installed or is not in PATH.
    pause
    exit /b 1
)

echo [INFO] Installing/checking Python backend requirements...
python -m pip install -r requirements.txt
if errorlevel 1 (
    color 0C
    echo [ERROR] Could not install Python requirements.
    pause
    exit /b 1
)

echo.
echo [INFO] Checking port %PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
    if not "%%a"=="0" (
        echo [INFO] Closing existing process on port %PORT%: %%a
        taskkill /F /PID %%a >nul 2>&1
    )
)

echo.
echo ============================================================
echo  Local URL  : %URL%             (learning resources portal)
echo  Phone app  : %URL%app/
echo  Schools    : %URL%schools         (find / create school)
echo  School log : %URL%login
echo  Admin ID   : ADM001
echo  Password   : admin123
echo ============================================================
echo.
echo Keep this window open while using the portal.
echo Press Ctrl+C to stop the Python server.
echo.

if /i not "%PORTAL_SKIP_BROWSER%"=="1" (
    start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 3; Start-Process '%URL%'"
)

python py_backend.py
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    color 0C
    echo The Python server stopped with error code %EXIT_CODE%.
) else (
    echo Python server stopped.
)
pause >nul
exit /b %EXIT_CODE%
