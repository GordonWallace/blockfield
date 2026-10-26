@echo off
rem Starts Blockfield: the game on http://localhost:8000 and the debug screen on http://localhost:8001,
rem and Blockfieldpedia (the wiki, wiki/) on http://localhost:8000/wiki/.
rem With them the world server (server/world.js): the game's simulation in Node, the page its client (open ?sim=server).
rem Extra options go to debug\server.js (--game <port>, --debug <port>, --lan, --saves <dir>, --no-world, --workers <n>). Needs Node.js.
cd /d "%~dp0"
where node >nul 2>nul || (echo Blockfield needs Node.js to run the game and debug servers: https://nodejs.org & exit /b 1)
node debug\server.js %*
