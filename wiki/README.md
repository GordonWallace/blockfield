# Blockfieldpedia

The Blockfield wiki. `./run.sh` serves it at http://localhost:8000/wiki/ next to the game.

## How it works
- `index.html`, `wiki.js`, `md.js`, `wiki.css`: the site. `data.html` loads a game's own scripts in a hidden iframe, so every block, item,
  recipe, smelting, trade, jobsite and mob fact on the generated pages comes from the game itself.
- Generated pages (no files to edit): every block and item, every villager profession (jobsite, trade table, restocks), every mob (stats,
  drops, habitat odds).
- Hand-written pages, per version in `versions/<id>/`:
  - `articles/<id>.md`: articles, listed in `articles/index.json` (menu order). Front matter `title` and `category`
    (World generation, Villages, Villagers, Mobs, Game rules, Items and blocks).
  - `articles/prof-<profession>.md` and `articles/mob-<type>.md`: the Behaviour section of a generated villager or mob page.
  - `natural.json`: where blocks generate (`blocks` by name, `rules` by name pattern).
  - Markdown with wiki links: `[[item:iron_ore]]`, `[[villager:farmer]]`, `[[mob:zombie]]`, `[[page:rivers]]`, optional `|label`.
- `test/wiki.js` (suite ui) builds every page and fails on a broken page or a link to something that doesn't exist.

## Versions
One wiki version per Blockfield release, listed newest first in `versions.json`. A selector at the top of every page shows the version
being read; it opens on the running game's version (`js/version.js`) and keeps the reader's choice for the browser session.

- **development**: the release being built. Its generated pages read the running game.
- **released**: frozen when its release branch merged into main. Its pages read the copy of the game in `versions/<id>/game/`, and nothing
  in `versions/<id>/` is edited again.

Current: **1.3, in development**.

Each version is self-contained: its pages, menu, search and links come only from its own game data and its own `versions/<id>/` pages, so
reading 1.3 never leads to something added in 1.4. A link to something the version doesn't have renders as red text (and fails
`test/wiki.js`); opening such a page (an old bookmark, or after switching versions) says it is not part of that version.

### Rules for every change
- A change to game behaviour updates the affected pages of the version under development in the same PR (the article, the `prof-`/`mob-`
  page, `natural.json`). Pages of released versions are never edited.
- New articles go in that version's `articles/index.json`.

### When a release starts development
`node wiki/version.js new 1.4` copies the newest version's pages into `versions/1.4/`, lists 1.4 as development and sets `js/version.js` to
1.4. Run it on the new release branch.

### When a release branch merges into main
`node wiki/version.js freeze 1.3` copies the game it documents (`index.html`, `js/`) into `versions/1.3/game/` and marks 1.3 released. Run it
on the release branch just before it merges, so main and later releases keep the frozen copy; from then on changes go into the next
version's pages.

### Pictures
Screenshots in `versions/<id>/images/` and the biome facts in `versions/<id>/biomes.json` come from the game itself:
`NODE_PATH=$(npm root -g) node wiki/capture.js <id> [name-prefix]` drives a headless game on seed 1337 (biome views, terrain, one village
per style, a portrait of every mob and profession). Rerun it, or just the affected prefix (`biome-`, `village-`, `mob-`, `villager-`),
when a change alters how something looks or where biomes fall. Block and item pictures are the game's own icons and need nothing.
