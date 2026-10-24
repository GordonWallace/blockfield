---
title: Running the game and the world server
category: Game rules
---
`./run.sh` (or `run.cmd` on Windows) starts everything Blockfield needs on your machine, using Node.js: the game at http://localhost:8000, the [[page:game-log|debug screen]] at http://localhost:8001 and this wiki at http://localhost:8000/wiki/. From 1.5 it also starts the **world server**: the game's simulation (mobs, villagers, crops, water, the clock and weather) running in that Node program rather than in the browser, like the server built into Minecraft's single-player game.

## What changes when the world runs on the server

The page then only draws the world and takes your input. It keeps its own copy of the terrain to draw and to walk about in, and the server sends it every block that changes, the mobs and villagers in view, the clock and the weather. Because the simulation is no longer in a browser tab it can use the machine's other cores and its own memory, and the browser can't slow it down.

- **Worlds are kept on the server.** The title screen lists the worlds saved by the server, a folder each in the `saves/` folder next to the game, rather than the ones in your browser's storage. Saving, autosaving and the [[page:game-log]] all happen on the server. The title screen can copy your browser's worlds to the server, and export and import worlds as files: see [[page:saving]].
- **Closing the page pauses the world at once** and saves it. The server keeps it ready: open the game again and pick the same world, and it carries on from where it was, at the fast-forward speed it had. Picking another world lets it go (it was already saved).
- **A hidden tab doesn't pause it.** With the simulation in the page or in a worker, hiding the tab pauses the game. On the server it keeps going while the page is open, so you can watch the debug screen on another monitor. The pause menu still pauses it.
- **One page plays at a time.** A second page opened while one is playing says *World in use* on its title screen and runs its own simulation, as it would without a server.
- **The debug screen reads the world from the server**, so it keeps showing the world (paused) after the page is closed.
- **If the server stops** (Ctrl+C, or a crash), the page says "World server stopped" and shows the game log's last lines. Ctrl+C saves every world first.

Everything you do plays the same in all three places. Some things the page used to do itself now go through the simulation wherever it runs: making an [[page:maps-and-compasses|auto-fill map]] from the width prompt, a held map filling in around you, sleeping in a bed (a second click while already asleep does nothing; see [[page:time-and-weather]]), and the pause menu's monster options, which reach the simulation as soon as you change them.

## The three ways the game runs

From 1.5 the simulation can run in one of three places, and the game picks one each time it starts:

1. **World server** (`./run.sh`): if the page was served by `./run.sh` and the server answers within a second, the simulation runs there, in Node. This is the main way to play.
2. **Browser (worker)**: otherwise, if the browser can, the simulation runs in a background thread of the page (a Web Worker; see [[page:performance-meter]]). This is what the online version uses, and a game served by any other web server.
3. **Browser (this page)**: a game opened straight from its file can't start a worker, so the simulation runs in the page itself, as it did before 1.5.

**How to tell which:** the pause menu's *Simulation* button and the last line of the F3 overlay say `World server (1 thread)`, `Browser (worker)` or `Browser (this page)`. When the page runs it because something else couldn't, F3 adds why (for example that the page was opened as a file). The [[page:game-log]] says it too, as the game starts.

**Choosing one yourself:** click the pause menu's *Simulation* button to cycle the setting through *Automatic* (the order above), *World server*, *Browser (worker)* and *Browser (this page)*. The browser remembers it, and it applies the next time the game starts: save and quit, then reload the page. A forced choice that can't run falls back the same way (no server: a worker; no worker: the page). Adding `?sim=server`, `?sim=worker`, `?sim=page` or `?sim=auto` to the game's address does the same for that visit only.

`./run.sh --lan` makes the game, the debug screen and the world server reachable from other machines on your network; without it they only answer on this machine. `./run.sh --saves <folder>` keeps the server's worlds somewhere else, and `./run.sh --no-world` starts no world server (the game then runs in a worker).
