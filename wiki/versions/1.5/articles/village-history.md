---
title: Village history
category: Game rules
---
The game keeps a history of how each village is doing over game time. The debug screen (`node debug/server.js`, then port 8001) shows it in its **History** panel under the village panel, as line graphs. Nothing in the game acts on it yet.

## Metrics
- **Population**: villagers in the village.
- **Food**: bread-equivalent its villagers hold, in their inventories and their chests.
- **Deaths** and **Trades**: how many in the 7 game days before each point (the same counts the [[page:villager-life]] happiness score uses).
- **Unemployment**: unemployed adults as a share of the village's adults. Children don't count.
- **Happiness**: the village's happiness score, 0 to 100.

## Scope
- **This village**: the village on show in the village panel. Several metrics can be on at once; each gets its own vertical axis in its colour. **Hide unloaded time** leaves out the time the village sat unloaded and marks each join with a dashed line.
- **Loaded villages** and **All villages ever loaded**: one metric, a thin line per village and a bold line for all of them together. Population, food, deaths and trades show the **total**; happiness shows the **average** of the villages; unemployment pools every adult of those villages. The village on show is drawn brighter, and clicking a line shows that village.

While a village is unloaded nothing about it changes, so its line goes on **dotted and flat** at its last value until it loads again. The total or average counts it at that value. Hovering shows the game time, the total or average and the nearest village.

The range buttons show the last game day, week, 30 days, or everything recorded.

## How it is recorded
The game records it, whether or not a debug screen is open. Every game hour while a village is loaded it takes a sample of the numbers above, and it notes the game time each village was loaded. Nothing is recorded for a village while it is unloaded. The history is saved with the world, so loading a save brings back the history up to that save. Older history thins out to keep saves small: hourly for the last 14 game days, then one sample every 6 game hours.

The debug screen only draws it. Other game code can read it too (`BF.vstats.latest` and `BF.vstats.series` in js/villagestats.js), for example a future village mayor deciding what to build.
