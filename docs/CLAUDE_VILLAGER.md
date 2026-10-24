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
- **Inventory:** the Sage starts with 3 to 6 random odds and ends, like any villager. The system prompt lists what it started with. The model also has one tool, `check_inventory`. The page sends the Sage's current bag with each message. When the model calls the tool, the server answers from that list, and the model then replies.
- **House designer:** the page sends your description and the list of blocks it can place (`js/housedesign.js` PALETTE) to `POST /claude/blueprint`. The system prompt is `prompts/house-designer.md`, and structured outputs force the reply into a JSON schema whose block names come from that list. The model draws the house as a stack of character grids, one per layer, with a legend. The server checks the drawing: grid sizes, unknown symbols, a full floor, a door in an outer wall with room for its upper half, and beds that come in pairs. If anything is wrong, it sends the drawing back with the list of problems, up to 3 drafts. **Revise** sends the current blueprint along with your changes.
- **Blueprints for builders:** `BF.houseDesign.toBlueprint(design)` works out what the drawing leaves out: which way doors, beds, ladders, wall torches, furnaces and chests face, the upper door half and the bed head, and a build phase for every cell. It then hands the cells to `BF.blueprints.custom()`, which shares its assembly code with the builders' own designs (`BF.blueprints.get`). The result has exactly the shape builders already build from: cells in build order with item and cost, `req`, `door`, `beds`. The original drawing is kept as `bp.design`. What builders would still need: a `custom` structure type in `js/builder.js` (rebuild the blueprint from the saved design) and a way to hand a design over, such as the Sage giving or selling it to a builder.
- **Debug screen, API calls:** the debug screen (`node debug/server.js`, port 8001) has an **API calls** button in its header. It lists every call the Sage made to the Claude API since the server started, newest first (the server keeps the last 60, in memory only). Pick one to see the request settings, the filled-in system prompt, the tools or output schema, the chat history sent with it, and every reply round by round: thinking, tool calls and their results, and the server's check of a blueprint between drafts. **Copy** copies the call as JSON. The API key is never part of a record.
- **Cost:** the API reports tokens, not dollars, so `debug/claude.js` works out each round's cost from Haiku 5.5's prices (`PRICE`: $0.10 per million input tokens, $0.50 per million output). The debug screen shows the cost of each round, each call, and the total since the server started. Update `PRICE` if the price or the model changes.
- **Game log:** entries of kind `claude`. INFO when the Sage appears (with its starting inventory), for each exchange (lengths, tokens and time, never the words), for each inventory check, and for each design (size, blocks, beds, drafts, tokens). WARN for a design that still had problems after the last draft. ERROR when a reply or a design fails.

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

- The Sage belongs to no village and isn't saved. It respawns when you come back near spawn, with the same inventory for the session. A new world gives it a new inventory.
- The conversation lasts for the browser session.
- It can't trade or give items yet. Nothing changes its inventory except the console: `BF.trades.inv.add(BF.claudeVillager.mob().inv, BF.I.diamond, 2)`.
- The world is paused while the trade screen is open, as for any villager.
- Designs last for the browser session. Their footprint is at most 15x15 and 14 layers tall. The designer runs at effort `medium`; set `BF_CLAUDE_DESIGN_EFFORT=high` for more careful (slower) drafts.

Test: `cd debug && npm install`, then `NODE_PATH=$(npm root -g) node test/claude-villager.js`. It uses a mock API and never the real one.
