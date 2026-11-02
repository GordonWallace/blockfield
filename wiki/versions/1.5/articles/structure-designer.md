---
title: Structure designer
category: World generation
---
The structure designer is a panel in [[page:sandbox-worlds]] where you describe a structure in words, Claude draws it, and the game builds it in front of you at once. You walk round it, change it by hand, and send it back to Claude to change further. It needs the game's local server and a Claude API key; it works in sandbox worlds only.

## Opening it

Press **G** in a sandbox world. Esc or Close shuts it.

The panel only works when the game is served by its own server (`./run.sh`, which runs `node debug/server.js`) and that server has a Claude API key. Without one the panel says so and offers nothing else. To set it up:

- put the key in the `ANTHROPIC_API_KEY` environment variable, or in the file `~/.config/blockfield/anthropic-key` (outside the game's folder, so it is never committed), or in a file named by `BF_CLAUDE_KEY_FILE`;
- run `npm install` once in the game's `debug` folder (it installs the Anthropic SDK);
- start the server again. Its start-up message says whether the designer is on.

The key stays in the server: the page never sees it, and only the game's own page on this computer can use it.

## Designing

Type what you want ("a two-storey spruce cottage with a chimney") and press **Design** (or Enter). After a few seconds the panel shows the design:

- a 3D preview you can turn by dragging and zoom with the wheel, with a **Layers** slider that cuts it away from the top so you can see inside (**Enlarge** makes the panel and preview bigger);
- its name, Claude's summary and notes, and the blocks it takes;
- any warnings: problems the server found and Claude couldn't fix after three tries (the design is still shown), doors or ladders that can't face anywhere sensible, and blocks kept from your own changes.

The next request changes the design you are looking at: Claude gets the current design with your request ("make it one storey taller"). **New design** starts afresh instead.

Designs are drawn as layers of rows of symbols (the same drawing the builders' blueprints come from), up to 24 by 24 blocks and 24 layers. Claude may use the usual building blocks: stone, bricks, planks and logs, glass, doors, beds, torches and lanterns, furnaces, chests and other furniture, ladders, and slabs and stairs of the common materials. The game works out which way doors, beds, ladders, wall torches, furnaces and chests face.

## Building

- **Build here** puts the design in the world at once: its front (the side with its door, else its south side) turned to face you, 3 blocks in front of you and centred on you, with its bottom layer in place of the grass. No builders and no materials: it simply appears.
- If that spot already holds something other than the plain (an earlier build, a scene, your own building), the panel says how many blocks it would cut into and offers **Build anyway**.
- **Rebuild** takes the last build away and puts the design you are looking at in the same spot, facing the same way. Use it after Claude sends a new version.
- **Clear** takes the last build away and puts the plain back.
- **Capture** reads what is now in the last build's space (and 2 blocks round it and above) back into a design, your changes by hand included. Grass at ground level counts as empty. Blocks Claude doesn't usually use keep their own names and are listed in the warnings; Claude is offered them too. The next request sends the captured design, so Claude carries on from your changes.

Builds go to the simulation as one batch, the same as [[page:sandbox-worlds]] scenes, so they work the same whether the simulation runs in the page, a worker or the [[page:world-server]].

## Versions

Every design Claude sends, every capture, every design loaded from the library and every restore is a numbered version (v1, v2, ...). Click a version to preview it; **Build** builds it in front of you; **Restore** makes it the current design again (as a new version), so the next request changes that one.

## Library

Type a name and press **Save** to keep the current design as `sandbox/structures/<name>.json` in the game's folder. Names are letters, digits, `-` and `_`. Saved designs are listed under Library: **Load** opens one as a new version, **Build** loads it and builds it in front of you.

Scene files can name a saved design: `{ "structure": "<name>", "at": [12, 0, 0], "facing": "west" }` builds it centred on the spot with its front to the facing (see [[page:sandbox-worlds]]).

## Model and cost

The **Model** setting picks which Claude model draws; the default is Claude Haiku 5.5 (the server's `BF_CLAUDE_MODEL` changes the default). The panel shows what the designer has spent in the last hour. The server stops sending requests once **$1** has been spent in a rolling hour (`BF_CLAUDE_PER_HOUR_USD` changes it), and also caps requests per minute and per day. When the cap is reached the panel says so; building, clearing and capturing still work.

Every request shows up in the debug screen's **API calls** panel (http://localhost:8001 while the server runs): the instructions Claude was given, the request settings, each message and reply, the tokens and the cost.

## Game log

INFO lines (`designer`) for each design received (model, attempts, cost), each build, rebuild, clear and capture, and each save. ERROR lines when a request, a save or a build fails.
