---
title: Texture studio
category: World generation
---
The texture studio is a panel in [[page:sandbox-worlds]] where you look at a block, say how its texture should change, and a model redraws it. Every block of that kind in view changes at once, without reloading. You can step back through versions, compare with the game's own texture, keep textures in a library, and adopt one so every world uses it. It needs the game's local server and a model provider (Claude by default); it works in sandbox worlds only.

## Opening it

Look at a block in a sandbox world and press **K**. Esc or Close shuts it.

Like the [[page:structure-designer]], the studio only works when the game is served by its own server (`./run.sh`, which runs `node debug/server.js`) with a provider set up. For Claude: put an API key in `ANTHROPIC_API_KEY` or `~/.config/blockfield/anthropic-key`, run `npm install` once in the `debug` folder, and start the server again. The key stays in the server; the page never sees it. Without a provider the panel says what is missing.

## Changing a texture

The panel shows the block's tiles (top, side, bottom, and front when the front differs). Pick the face to change, or **All** to give every face the same result, type what you want ("mossier", "with gold veins", "red bricks"), and press the change button (or Enter).

The model gets your words, the tile as it is now, a close-up of the block in the world as the game draws it, and your earlier requests for that tile, so "a bit darker" carries on from the last change. It answers in one of three ways:

- **a pixel grid**: 32 rows of 32 symbols with a colour for each symbol. Short rows or unknown symbols are fixed and listed (an answer that needs too many fixes goes back once with the problems);
- **a recipe**: steps on the game's own texture painters (stone, cobble, bricks, planks, bark, log ends, leaves, ore specks, moss, frames, single pixels, relief shading). These keep the game's look and tile seamlessly;
- **an image**, from a provider that draws pictures: the server shrinks it to 32x32, keeps at most 32 colours, and blends its edges so it tiles.

Grass and leaves are coloured by the biome: they are edited in grey and the panel says so. Animated tiles (water, lava) can't be edited.

## Versions, undo and compare

Every change is a numbered version of that tile. **Undo** goes back one version; **Restore** on any version puts it back; **Original** puts back the game's own tile. **Compare** shows the game's own tile on every block until you press it again.

## Library

Type a name and press **Save** to keep the current texture as `sandbox/textures/<name>.png`, with a `<name>.json` record of the requests and the recipe (if any). **Apply** puts a saved texture on the face you are looking at.

Library textures and changes in progress belong to sandbox worlds: open a normal world and the game's own tiles come back.

## Use in all worlds

**Use in all worlds** on a library texture asks which block and face it is for, then adopts it: every world, sandbox or not, uses it from then on, on this computer. Adoptions are kept in `sandbox/adopted.json` and `sandbox/adopted.js` (commit them to share them). Adopting a second texture for the same tile replaces the first, with a warning. **Unadopt** gives the game's own tile back.

## Providers, model and cost

The provider and model are chosen in the panel. Claude (the default) uses Claude Haiku 5.5 unless another model is picked. Other companies' image models can be added as a file in `debug/providers/` (see `template.js` there); each needs its own key on the server.

The studio shares the structure designer's spending limit: the server stops sending requests once **$1** has been spent in a rolling hour (`BF_CLAUDE_PER_HOUR_USD` changes it). Every request shows in the debug screen's **API calls** panel (http://localhost:8001) as a Texture call with its messages, tokens and cost.

## Game log

INFO lines (`textures`) for each change (provider, model, kind of answer, cost and any fixes), undo, restore, save, library apply, adoption and unadoption, and when sandbox textures are put back outside a sandbox world. ERROR lines when a request, a save or an adoption fails.
