# Claude villager (experimental)

Branch `exp-llm-villager`, off `release-1-4`. Not targeted at a release yet.

A villager called the Sage stands a few blocks from the world spawn. Right-click it and its trade screen opens (it has no trades yet), with a panel on the right. The panel has two tabs:

- **Chat**: you type and it answers through Claude (Haiku 5.5) using your own Anthropic API key.
- **House designer**: describe a house and the Sage draws a blueprint. The tab shows a 3D view you can turn, a layer slider for looking inside, and a materials list.

## How it fits together

```
browser                         POST /claude/chat        run.sh / debug/server.js           Anthropic SDK
  js/claudevillager.js  ------> POST /claude/blueprint -> debug/claude.js  ------------------------> Claude API
  (Sage, trade-screen panel)                             holds the API key, builds the system
  js/housedesign.js                                      prompts, runs check_inventory, checks
  (drawing -> builder blueprint, 3D view)                house drawings and asks for fixes
```

- **The key never reaches the browser.** The game page talks only to the local server it was loaded from. `debug/claude.js` reads the key when the server starts and adds it to the API calls it makes. The key is not in the page, not in the repo, and not served as a file.
- **The Sage only appears when a key is set.** If you have no key (CI, a fresh checkout, the published Artifact), the game plays as before. `?claude=0` turns the Sage off even with a key.
- **The system prompt** is `prompts/villager-system.md`. It is re-read for every message, so you can edit it while the game runs.
- **Tools are answered by the game, live.** The model has three tools, defined in `debug/claude.js`. When it calls one, the server hands the call back to the page (`{ pending: { turn, calls } }`), the page works out the answer from the world as it is at that moment, and posts it back (`{ turn, results }`). The server then carries on with the model. Nothing depends on the game being paused, so the same loop will work when the Sage acts on its own.
- **Inventory:** the Sage starts with 3 to 6 random odds and ends, like any villager. The system prompt lists what it started with. `check_inventory` reads its bag as it is now.
- **Where it is:** the system prompt's "Where you are" line comes from `BF.claudeSight.where` (`js/claudesight.js`): the biome, the climate band and latitude, its height above sea level, and the nearest village with its name, distance and compass direction.
- **Looking around:** `look_around` (`BF.claudeSight.look`) lists what the Sage can actually see from its eye, with compass directions and distances:
  - creatures, people (named, with what they're doing), monsters, and the player, within 96 blocks
  - flowers, trees (counted by trunk), crops (ripe or young) and farmland, workstations (whose they are), houses (from the villages' house plots), doors, beds, windows, chests and other signs of people, water and paths, within 64 blocks
  - the land for each compass point: how far the view runs at eye level and what stops it (trees, a wall, rising ground), what's underfoot, and whether the land rises or falls. Indoors it says so and names the openings.
  
  Line of sight is a voxel ray walk like `world.raycast`, the one mobs use for `hasLineOfSight`. Opaque blocks and leaves block the view. Glass, panes, fences, doors, plants and crops don't, and water lets a few blocks through. A ray stops at an unloaded chunk. Creatures are seen when a ray reaches their head or middle. Blocks come from a sweep of 1,320 rays all round (every 3 degrees at 11 heights), which takes about 5 to 20 ms. In the dark the range shrinks toward 16 blocks, except to things standing in torchlight.
- **House designer:** the page sends your description and the list of blocks it can place (`js/housedesign.js` PALETTE) to `POST /claude/blueprint`. The system prompt is `prompts/house-designer.md`, and structured outputs force the reply into a JSON schema whose block names come from that list. The model draws the house as a stack of character grids, one per layer, with a legend. The server checks the drawing: grid sizes, unknown symbols, a full floor, a door in an outer wall with room for its upper half, and beds that come in pairs. If anything is wrong, it sends the drawing back with the list of problems, up to 3 drafts. **Revise** sends the current blueprint along with your changes.
- **Blueprints for builders:** `BF.houseDesign.toBlueprint(design)` works out what the drawing leaves out: which way doors, beds, ladders, wall torches, furnaces and chests face, the upper door half and the bed head, and a build phase for every cell. It then hands the cells to `BF.blueprints.custom()`, which shares its assembly code with the builders' own designs (`BF.blueprints.get`). The result has exactly the shape builders already build from: cells in build order with item and cost, `req`, `door`, `beds`. The original drawing is kept as `bp.design`. What builders would still need: a `custom` structure type in `js/builder.js` (rebuild the blueprint from the saved design) and a way to hand a design over, such as the Sage giving or selling it to a builder.
- **Debug screen, API calls:** the debug screen (`node debug/server.js`, port 8001) has an **API calls** button in its header. It lists every call the Sage made to the Claude API since the server started, newest first (the server keeps the last 60, in memory only). Pick one to see the request settings, the filled-in system prompt, the tools or output schema, the chat history sent with it, and every reply round by round: thinking, tool calls and their results, and the server's check of a blueprint between drafts. **Copy** copies the call as JSON. The API key is never part of a record.
- **Cost:** the API reports tokens, not dollars, so `debug/claude.js` works out each round's cost from Haiku 5.5's prices (`PRICE`: $0.10 per million input tokens, $0.50 per million output). The debug screen shows the cost of each round, each call, and the total since the server started. Update `PRICE` if the price or the model changes.
- **Walking (`move_to`):** the model can send the Sage to the traveller, back to its spot by the spawn, to the nearest village, or some blocks off toward a compass point (up to 100), or tell it to stop. The tool returns at once ("you set off"). `js/mobs.js` (`claudeErrand`) then walks it the way villagers walk: A* routes in hops of up to 20 blocks, bridges included, opening doors on the way. When the walk ends, the game tells the Sage in a new turn of its own, a message marked as a world event ("You have arrived at the traveller. The traveller is about 3 blocks west of you."), or that it didn't make it and why. The Sage can then look around and report. Its reply shows in the panel, or in the game's chat (`<Sage> ...`) when the panel is closed. Where it ends up becomes the spot it wanders around. The world is paused while the trade screen is open, so it sets off once you close it.
- **Game log:** entries of kind `claude`. INFO when the Sage appears (with its starting inventory), for each exchange (lengths, tokens and time, never the words), for each inventory check and look around (what it saw, in numbers), each errand set off and arrived (WARN when it didn't get there), each world event told to it, and for each design (size, blocks, beds, drafts, tokens). WARN for a design that still had problems after the last draft. ERROR when a reply or a design fails.

## Setup (once)

1. Create an API key in the Claude Console (console.anthropic.com, API keys). Set a monthly spend limit on it too. Haiku 5.5 costs $0.10 per million input tokens and $0.50 per million output tokens. A chat message costs a fraction of a cent, and a design (a few thousand tokens, sometimes 2 or 3 drafts) costs well under a cent.
2. Install the SDK: `cd debug && npm install`.
3. Give the server the key. Pick one:
   - **File (recommended):** `mkdir -p ~/.config/blockfield && printf '%s' 'sk-ant-...' > ~/.config/blockfield/anthropic-key && chmod 600 ~/.config/blockfield/anthropic-key`. The file sits outside the checkout, so it can't be committed.
   - **Environment variable:** `ANTHROPIC_API_KEY=sk-ant-... ./run.sh`. Leave it out of shell history and scripts in the repo.
   - Another file: `BF_CLAUDE_KEY_FILE=/path/to/key ./run.sh`.
4. Run `./run.sh` as usual. The startup banner prints `Claude villager: on (claude-haiku-5-5)`.

## Guards

- Only this computer can use the chat endpoint, even with `--lan`, unless you set `BF_CLAUDE_LAN=1`.
- Requests from other websites are refused, so another page open in your browser can't spend the key.
- Message size and history length are capped. There are also caps per minute and per day: `BF_CLAUDE_PER_MIN` (default 12) and `BF_CLAUDE_PER_DAY` (default 400) for each server run.

## Limits of the prototype

- The Sage belongs to no village. Its bag (what it carries now), the list of what it started with, and the spot it last settled are saved with the world (`claude` in the save, `BF.claudeVillager.serialize`). It comes back at that spot when you're within 64 blocks of it, or at its spot by the spawn. A new world, or one saved before this, gives it a fresh random bag. If its chunk unloads while it's away on an errand, it settles where it was.
- The conversation and designs last for the browser session; they aren't saved.
- It can't trade or give items yet. Nothing changes its inventory except the console: `BF.trades.inv.add(BF.claudeVillager.mob().inv, BF.I.diamond, 2)`.
- The world is paused while the trade screen is open, as for any villager.
- Designs last for the browser session. Their footprint is at most 15x15 and 14 layers tall. The designer runs at effort `medium`; set `BF_CLAUDE_DESIGN_EFFORT=high` for more careful (slower) drafts.

Tests: `cd debug && npm install`, then `NODE_PATH=$(npm root -g) node test/claude-villager.js` and `NODE_PATH=$(npm root -g) node test/claude-sight.js` (line of sight on a test ground in the sky, the tool round trip, walking round a wall to the traveller and failing to reach a spot off the edge). Both use a mock API and never the real one.
