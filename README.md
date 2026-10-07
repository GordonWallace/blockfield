# Blockfield

A Minecraft-style voxel game that runs in the browser. Plain JavaScript modules on a global `BF` object, rendered with Three.js r128 (loaded from a CDN).

## Run

Open `index.html` in a browser, or serve the folder:

    python3 -m http.server 8000

then visit http://localhost:8000. Worlds save in the browser (IndexedDB).

## Debug screen on a second monitor

    node debug/server.js

then open http://localhost:8000 (the game) on one screen and http://localhost:8001 (the debug screen) on the other. Node only, no packages to install. The debug screen shows everything the F3 overlay and village panel do, live: frame rate, position, chunks, mobs, light, weather, and for the village you are in its villagers, beds, job blocks, occupations, a map with every villager on it, a roster with what each one is doing, and the full village log with filters and search.

- Keep the game in its own browser window, not a background tab: browsers pause background tabs.
- Other ports: `node debug/server.js --game 9000 --debug 9001`. From another computer on your network: add `--lan`.
- The feed is always on and doesn't change anything in the game, F3 included. However you open the game (this server, `python3 -m http.server`, or the file itself), it streams to port 8001 on the same machine. To use only the debug screen with your own game server: `node debug/server.js --no-game`. `?debugfeed=<port>` points it elsewhere and `?debugfeed=off` turns it off.
- With no debug server running, the game plays as normal and quietly retries every few seconds.

## Layout

- `index.html`: entry page and script load order
- `js/`: game modules (world generation, rendering, mobs, villages, trading, inventory, sound, ...)
- `debug/`: the second-screen debug server and page (`js/debugfeed.js` is the game side)
- `CONTRACT.md`: each module's API
- `BLOCK_GAP.md`: vanilla blocks still missing
- `TRADE_AUDIT.md`: villager trade audit
- `v1-basic.html`: the original single-file demo
- `test/run.js`: headless Chromium smoke test (`NODE_PATH=$(npm root -g) node test/run.js <outPrefix>`); uses `.three-test.min.js` in place of the CDN
- `test/debug-screen.js`: debug screen end-to-end test (`NODE_PATH=$(npm root -g) node test/debug-screen.js <outPrefix>`)

## Workflow

`main` tracks the game. Make changes on a branch and open a pull request.

## Credits

Textures are from the Faithful 32x pack, https://faithfulpack.net. See `FAITHFUL-LICENSE.txt`. The band saw tiles are the artwork of the villager-planter mod (GordonWallace/villager-planter). Everything else is project code.
