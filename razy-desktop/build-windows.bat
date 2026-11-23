@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(/^\d{15,25}$/.test(String(require('./config.json').clientId))?0:1)" >nul 2>nul
if not errorlevel 1 goto hasid
set /p DID=Paste Discord Application ID and press Enter (or just Enter to skip): 
node -e "if(process.argv[1].trim()){const c=require('./config.json');c.clientId=process.argv[1].trim();require('fs').writeFileSync('config.json',JSON.stringify(c))}" "%DID%"
:hasid
echo Installing dependencies...
call npm install
if errorlevel 1 goto err
echo Building installer...
call npm run dist:win
if errorlevel 1 goto err
echo.
echo Done! Razy-Setup is in the dist folder.
start "" dist
pause
exit /b 0
:nonode
echo Install Node.js from https://nodejs.org and run this file again.
pause
exit /b 1
:err
echo Build failed. Try running as administrator.
pause
exit /b 1
