@echo off
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=3000
if "%HOST%"=="" set HOST=0.0.0.0
python -m pip install -r requirements.txt
if errorlevel 1 exit /b 1
python py_backend.py
