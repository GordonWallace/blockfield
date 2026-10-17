@echo off
rem Starts Blockfield: the game on http://localhost:8000 and the debug screen on http://localhost:8001.
rem Extra options go to debug\server.js (--game <port>, --debug <port>, --lan). Needs Node.js.
cd /d "%~dp0"
where node >nul 2>nul || (echo Blockfield needs Node.js to run the game and debug servers: https://nodejs.org & exit /b 1)
node debug\server.js %*
