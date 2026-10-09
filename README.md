# Blockfield

A Minecraft-style voxel game that runs in the browser. Plain JavaScript modules on a global `BF` object, rendered with Three.js r128 (loaded from a CDN).

## Run

    ./run.sh          (macOS / Linux)
    run.cmd           (Windows)

This serves the game on http://localhost:8000 and the debug screen on http://localhost:8001 (it runs `node debug/server.js`, so it needs Node.js, but no packages). Open the game in your browser and, if you want it, the debug screen on a second monitor. Ctrl+C stops it. Worlds save in the browser (IndexedDB).

You can also open `index.html` directly or serve the folder some other way (`python3 -m http.server 8000`); the game works the same, but the debug screen only exists while the run script or `node debug/server.js` is running.

## Debug screen on a second monitor

Start the game with the run script above (or `node debug/server.js`), then open http://localhost:8000 (the game) on one screen and http://localhost:8001 (the debug screen) on the other. Node only, no packages to install. The debug screen shows everything the F3 overlay and village panel do, live: frame rate, position, chunks, mobs, light, weather, and for the village you are in its villagers, beds, job blocks, occupations, a map with every villager on it (houses, farms and gardens, paddocks and other buildings each in their own colour, with a legend, and a star on everything a builder villager made; dashed while still going up), a roster with what each one is doing, its emeralds and food (bread-equivalent, carried plus in the chests it owns) whether it is starving and its age: the game days it has actually been loaded and active (time its village sat unloaded doesn't count, so a village visited on day 1 and again on day 60 hasn't aged 59 days), and the full village log with search. Under the villager list, Past villagers lists everyone who has died in the village (newest first) with their job, when and how they died, and their age, and the list's header counts them. Each village has a happiness score out of 100: 100, minus 10 per villager killed in the last 7 game days, minus 5 per villager starving now, plus 1 per trade in the last week, plus 5 per birth and per child grown up in the last week, minus 3 per unemployed adult and per adult with no emeralds (carried or in its chests), kept between 0 and 100. The panel shows each part with its count and points. The weights and terms are the `TERMS` table at the top of `js/happiness.js`: change a weight, delete a line or add one. A village list shows every village the world has loaded, with its distance from you, its age (counted the same way) and its happiness: loaded villages first (green dot), then the rest by distance. The screen follows the nearest loaded village until you pick another; an unloaded village shows its last known numbers greyed out. The log scrolls back through the village's whole history: the game saves the newest 300 entries per village, and the debug server keeps everything it has seen while it runs. The log has two filter dropdowns that read as a sentence, "Show [villagers] [events]". The first lists every villager type (plus Child and Player) in one column, whether or not it lives in that village or has logged anything yet; each type's arrow unfolds a checkbox per action (buying, selling, beds, chests, taking the job, being born, dying). The second lists event types: trades, beds and tents, chests, job changes, births and deaths. Both have Select all and Select none at the top, and they combine: Explorer + Deaths shows only explorer deaths. Everything starts checked, and "Clear filters" shows everything again. An entry shows while any villager in it is selected: with Builder on and Furniture Maker off, a builder buying from a furniture maker still shows. Your choices are remembered in that browser.

- Keep the game in its own browser window, not a background tab: browsers pause background tabs.
- Other ports: `./run.sh --game 9000 --debug 9001` (or the same options on `run.cmd` / `node debug/server.js`). From another computer on your network: add `--lan`.
- The feed is always on and doesn't change anything in the game, F3 included. However you open the game (this server, `python3 -m http.server`, or the file itself), it streams to port 8001 on the same machine. To use only the debug screen with your own game server: `node debug/server.js --no-game`. `?debugfeed=<port>` points it elsewhere and `?debugfeed=off` turns it off.
- With no debug server running, the game plays as normal and quietly retries every few seconds. The game's browser console says where the feed is sending (`Blockfield debug feed: ...`).
- Game served somewhere else (another port, `127.0.0.1`, `0.0.0.0`): the feed tries port 8001 on the game's host, then `localhost` and `127.0.0.1`. If you open the game by your computer's network address or name (`http://192.168.1.5:8080`, `mymac.local`), start the debug server with `--lan`, because browsers won't let such a page talk to `localhost`.
- Debug screen stuck on "Waiting for the game" with the game open: Shift+Reload the game tab in case the browser kept older cached game files.

## Tests and CI

GitHub Actions runs the headless tests (`.github/workflows/`), one at a time, in two tiers set in `test/ci.json`:

- **Baseline tests** run on every pull request into a `release-*` branch or `main`: a quick smoke set, about 5 minutes. Keep it light: only tests under about 20 seconds that cover something core belong in it.
- **Suites**: `test/ci.json` groups every test into a suite by game area: `jobs`, `farming`, `village`, `world`, `items` and `ui` (`node test/ci.js suites` lists them). A pull request into a release branch adds the suites for the areas it touched with a line in its description, such as `CI suites: jobs, village` (or `all`, or `none`). Editing the line re-runs the check. Locally, use `CI_SUITES="jobs ui" node test/ci.js baseline`. A new test goes into the suite of its area in `test/ci.json`.
- **Soak**: a suite runs without its long tests (over about 75 s in CI: soaks, multi-day fast-forwards, big map generation), so each suite takes a few minutes (farming and items about 3, the others about 6 to 8). Add `soak` to the line (`CI suites: village, soak`) only when the change needs a long test as evidence; `all` includes them. Integration always runs them. Name only the one or two suites your change touches: five suites without soak is still about half an hour. A new test that takes over about 75 s also goes in the `soak` list in `test/ci.json`.
- **Integration tests** (baseline plus everything else: soak, generator, map and slower feature tests, about an hour) run on the pull request that takes a release branch into `main`, so right before a release ships. They don't run on each push to a release branch; start them from the Actions tab (Integration tests, Run workflow, pick the branch) to check a release branch earlier.

Each run's page has a results table, and the logs and screenshots are attached to it. A test fails when it exits non-zero, times out, uses more than 10 GB of memory (it is stopped so the rest of the run still reports), throws in the page, or prints a line starting with `FAIL`. Run a tier locally with `NODE_PATH=$(npm root -g) node test/ci.js baseline` (or `integration`, or name tests after the output folder: `node test/ci.js baseline ci-out esc-close`). A new test file needs no entry in `test/ci.json`: it runs in integration, or in the tier named by a `// @ci baseline` comment in the file (baseline only for quick, core tests).

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
