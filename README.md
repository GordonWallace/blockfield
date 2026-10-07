# Blockfield

A Minecraft-style voxel game that runs in the browser. Plain JavaScript modules on a global `BF` object, rendered with Three.js r128 (loaded from a CDN).

## Run

Open `index.html` in a browser, or serve the folder:

    python3 -m http.server 8000

then visit http://localhost:8000. Worlds save in the browser (IndexedDB).

## Debug screen on a second monitor

    node debug/server.js

then open http://localhost:8000 (the game) on one screen and http://localhost:8001 (the debug screen) on the other. Node only, no packages to install. The debug screen shows everything the F3 overlay and village panel do, live: frame rate, position, chunks, mobs, light, weather, and for the village you are in its villagers, beds, job blocks, occupations, a map with every villager on it, a roster with what each one is doing, and the full village log with search. A village list shows every village the world has loaded, with its distance from you: loaded villages first (green dot), then the rest by distance. The screen follows the nearest loaded village until you pick another; an unloaded village shows its last known numbers greyed out. The log scrolls back through the village's whole history: the game saves the newest 300 entries per village, and the debug server keeps everything it has seen while it runs. The log has a grid of every villager type (plus Child and Player), whether or not it lives in that village or has logged anything yet, each with a dropdown holding a checkbox per action: buying, selling, placing beds, taking the job, being born, dying. Each type's chip also has its own checkbox to turn all of it on or off, and Select all / Select none set every type at once (Select none, then tick Forester, shows only foresters). Everything starts checked. An entry shows while any villager in it is selected: with Builder on and Furniture Maker off, a builder buying from a furniture maker still shows. Your choices are remembered in that browser.

- Keep the game in its own browser window, not a background tab: browsers pause background tabs.
- Other ports: `node debug/server.js --game 9000 --debug 9001`. From another computer on your network: add `--lan`.
- The feed is always on and doesn't change anything in the game, F3 included. However you open the game (this server, `python3 -m http.server`, or the file itself), it streams to port 8001 on the same machine. To use only the debug screen with your own game server: `node debug/server.js --no-game`. `?debugfeed=<port>` points it elsewhere and `?debugfeed=off` turns it off.
- With no debug server running, the game plays as normal and quietly retries every few seconds. The game's browser console says where the feed is sending (`Blockfield debug feed: ...`).
- Game served somewhere else (another port, `127.0.0.1`, `0.0.0.0`): the feed tries port 8001 on the game's host, then `localhost` and `127.0.0.1`. If you open the game by your computer's network address or name (`http://192.168.1.5:8080`, `mymac.local`), start the debug server with `--lan`, because browsers won't let such a page talk to `localhost`.
- Debug screen stuck on "Waiting for the game" with the game open: Shift+Reload the game tab in case the browser kept older cached game files.

## Tests and CI

GitHub Actions runs the headless tests (`.github/workflows/`), one at a time, in two tiers set in `test/ci.json`:

- **Baseline tests** run on every pull request into a `release-*` branch or `main` (about 15 minutes).
- **Integration tests** (baseline plus the soak, generator and slow map tests, about an hour) run on every push to a `release-*` branch, so after each merged PR, and on a pull request from a release branch into `main`. Either workflow can also be started by hand from the Actions tab.

Each run's page has a results table, and the logs and screenshots are attached to it. A test fails when it exits non-zero, times out, throws in the page, or prints a line starting with `FAIL`. Run a tier locally with `NODE_PATH=$(npm root -g) node test/ci.js baseline` (or `integration`, or name tests after the output folder: `node test/ci.js baseline ci-out esc-close`). A new test file needs no entry in `test/ci.json`: it runs in integration, or in the tier named by a `// @ci baseline` comment in the file.

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
