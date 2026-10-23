# Claude villager (experimental)

Branch `exp-llm-villager`, off `release-1-4`. Not targeted at a release yet.

A villager called the Sage stands a few blocks from the world spawn. Right-click it and a chat panel opens. You type, and it answers through Claude (Haiku 5.5) using your own Anthropic API key.

## How it fits together

```
browser (js/claudevillager.js)  --POST /claude/chat-->  run.sh / debug/server.js (debug/claude.js)  --Anthropic SDK-->  Claude API
        chat panel, Sage mob,                              holds the API key, builds the system
        sends history + inventory                          prompt, runs the check_inventory tool
```

- **The key never reaches the browser.** The game page talks only to the local server it was loaded from. `debug/claude.js` reads the key when the server starts and adds it to the API calls it makes. The key is not in the page, not in the repo, and not served as a file.
- **The Sage only appears when a key is set.** If you have no key (CI, a fresh checkout, the published Artifact), the game plays as before. `?claude=0` turns the Sage off even with a key.
- **The system prompt** is `prompts/villager-system.md`. It is re-read for every message, so you can edit it while the game runs.
- **Inventory:** the Sage starts with 3 to 6 random odds and ends, like any villager. The system prompt lists what it started with. The model also has one tool, `check_inventory`. The page sends the Sage's current bag with each message. When the model calls the tool, the server answers from that list, and the model then replies.
- **Game log:** entries of kind `claude`. INFO when the Sage appears (with its starting inventory), for each exchange (lengths, tokens and time, never the words), and for each inventory check. ERROR when a reply fails.

## Setup (once)

1. Create an API key in the Claude Console (console.anthropic.com, API keys). Set a monthly spend limit on it too. Haiku 5.5 costs $0.10 per million input tokens and $0.50 per million output tokens, so a chat costs a fraction of a cent.
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
- The world is paused while the chat is open, as it is at the trade screen.

Test: `cd debug && npm install`, then `NODE_PATH=$(npm root -g) node test/claude-villager.js`. It uses a mock API and never the real one.
