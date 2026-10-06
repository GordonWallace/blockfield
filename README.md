# Blockfield

A Minecraft-style voxel game that runs in the browser. Plain JavaScript modules on a global `BF` object, rendered with Three.js r128 (loaded from a CDN).

## Run

Open `index.html` in a browser, or serve the folder:

    python3 -m http.server 8000

then visit http://localhost:8000. Worlds save in the browser (IndexedDB).

## Layout

- `index.html`: entry page and script load order
- `js/`: game modules (world generation, rendering, mobs, villages, trading, inventory, sound, ...)
- `CONTRACT.md`: each module's API
- `BLOCK_GAP.md`: vanilla blocks still missing
- `TRADE_AUDIT.md`: villager trade audit
- `v1-basic.html`: the original single-file demo
- `test/run.js`: headless Chromium smoke test (`NODE_PATH=$(npm root -g) node test/run.js <outPrefix>`); uses `.three-test.min.js` in place of the CDN

## Workflow

`main` tracks the game. Make changes on a branch and open a pull request.

## Credits

Textures are from the Faithful 32x pack, https://faithfulpack.net. See `FAITHFUL-LICENSE.txt`. Everything else is project code.
