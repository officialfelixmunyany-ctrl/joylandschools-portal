@echo off
setlocal EnableExtensions

if /i not "%~1"=="--run" (
    start "JOYLAND SCHOOLS PORTAL" "%ComSpec%" /k ""%~f0" --run"
    exit /b
)

cd /d "%~dp0"
if errorlevel 1 (
    color 0C
    echo.
    echo [ERROR] Could not open the portal folder:
    echo %~dp0
    echo.
    pause
    exit /b 1
)

title JOYLAND SCHOOLS PORTAL
color 0A
cls

set "PORT=3000"
set "HOST=0.0.0.0"
set "URL=http://localhost:%PORT%/"
set "PORTAL_DEV_REFRESH=1"

echo.
echo ============================================================
echo      JOYLAND SCHOOLS PORTAL
echo      Education Is Treasure
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    color 0C
    echo [ERROR] Node.js is not installed or is not in PATH.
    echo.
    echo Install the latest LTS version from:
    echo https://nodejs.org/en/download
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%i in ('node --version') do set "NODE_VER=%%i"
echo [OK] Node.js %NODE_VER% detected

node -e "require('node:sqlite')" >nul 2>&1
if errorlevel 1 (
    color 0C
    echo.
    echo [ERROR] This portal needs Node.js 22.5 or newer.
    echo Your detected version is %NODE_VER%.
    echo.
    echo Install the latest LTS version from:
    echo https://nodejs.org/en/download
    echo.
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    color 0C
    echo.
    echo [ERROR] npm was not found. Reinstall Node.js and include npm.
    echo.
    pause
    exit /b 1
)

if not exist "package.json" (
    color 0C
    echo.
    echo [ERROR] package.json was not found in:
    echo %CD%
    echo.
    echo Keep start.bat inside the portal folder and run it again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo.
    echo [INFO] First run: installing packages. This may take a minute.
    echo.
    call npm install
    if errorlevel 1 (
        color 0C
        echo.
        echo [ERROR] npm install failed.
        echo Check your internet connection, then run start.bat again.
        echo.
        pause
        exit /b 1
    )
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
echo [INFO] Checking LAN firewall access...
set "FIREWALL_RULE=JOYLAND Schools Portal TCP %PORT%"
net session >nul 2>&1
if errorlevel 1 (
    echo [INFO] Not running as Administrator, so no firewall rule was changed.
    echo [INFO] If LAN devices cannot connect, run start.bat as Administrator once
    echo [INFO] or allow Node.js through Windows Firewall on Private/Public networks.
) else (
    netsh advfirewall firewall show rule name="%FIREWALL_RULE%" >nul 2>&1
    if errorlevel 1 (
        netsh advfirewall firewall add rule name="%FIREWALL_RULE%" dir=in action=allow protocol=TCP localport=%PORT% profile=private,public >nul 2>&1
        if errorlevel 1 (
            echo [WARN] Could not add the firewall rule automatically.
        ) else (
            echo [OK] Firewall rule added for LAN access on port %PORT%.
        )
    ) else (
        netsh advfirewall firewall set rule name="%FIREWALL_RULE%" new dir=in action=allow protocol=TCP localport=%PORT% profile=private,public >nul 2>&1
        if errorlevel 1 (
            echo [WARN] Could not update the existing firewall rule.
        ) else (
            echo [OK] Firewall rule is ready for LAN access on port %PORT%.
        )
    )
)

echo.
echo ============================================================
echo  Local URL  : %URL%
echo  LAN URLs   :
node -e "const os=require('os');const port=process.env.PORT||'%PORT%';const urls=[];const ignored=/brave|vpn|virtual|vEthernet|hyper-v|vmware|virtualbox|loopback|tunnel|tap|npcap|docker|wsl|tailscale|zerotier|anydesk/i;for(const [name,entries] of Object.entries(os.networkInterfaces())){if(ignored.test(name)) continue;for(const entry of entries||[]){const isIPv4=entry.family==='IPv4'||entry.family===4;if(isIPv4&&!entry.internal&&entry.address&&!entry.address.startsWith('169.254.')) urls.push({name,address:entry.address});}}urls.sort((a,b)=>(/wi-?fi|wireless|wlan/i.test(a.name)?0:1)-(/wi-?fi|wireless|wlan/i.test(b.name)?0:1)||a.name.localeCompare(b.name)||a.address.localeCompare(b.address));if(urls.length){for(const u of urls) console.log('             http://'+u.address+':'+port+'/  ('+u.name+')');}else{console.log('             No active LAN IPv4 address found.');}"
echo.
echo  Admin ID   : ADM001
echo  Password   : admin123
echo ============================================================
echo.
echo Open a LAN URL above on phones or other computers connected to
echo the same Wi-Fi network.
echo.
echo If another device cannot connect, run this start.bat as
echo Administrator once so Windows Firewall can allow port %PORT%.
echo.
if /i "%PORTAL_SKIP_BROWSER%"=="1" (
    echo Browser launch skipped for this run.
) else (
    echo Opening browser in a few seconds...
)
echo Keep this window open while using the portal.
echo Press Ctrl+C to stop the server.
echo Soft refresh is enabled for admin/app file changes.
echo.

if /i not "%PORTAL_SKIP_BROWSER%"=="1" (
    start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 3; Start-Process '%URL%'"
)

node --no-warnings server.js
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    color 0C
    echo ============================================================
    echo The server stopped with error code %EXIT_CODE%.
    echo Read the message above, then press any key to close.
    echo ============================================================
) else (
    echo ============================================================
    echo Server stopped. Press any key to close.
    echo ============================================================
)
pause >nul
exit /b %EXIT_CODE%
