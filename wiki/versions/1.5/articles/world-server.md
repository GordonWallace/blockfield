---
title: Running the game and the world server
category: Game rules
---
`./run.sh` (or `run.cmd` on Windows) starts everything Blockfield needs on your machine, using Node.js: the game at http://localhost:8000, the [[page:game-log|debug screen]] at http://localhost:8001 and this wiki at http://localhost:8000/wiki/. From 1.5 it also starts the **world server**: the game's simulation (mobs, villagers, crops, water, the clock and weather) running in that Node program rather than in the browser, like the server built into Minecraft's single-player game.

## What changes when the world runs on the server

The page then only draws the world and takes your input. It keeps its own copy of the terrain to draw and to walk about in, and the server sends it every block that changes, the mobs and villagers in view, the clock and the weather. Because the simulation is no longer in a browser tab it can use the machine's other cores and its own memory, and the browser can't slow it down.

- **Worlds are kept on the server.** The title screen lists the worlds saved by the server, in the `saves/` folder next to the game, rather than the ones in your browser's storage. Saving, autosaving and the [[page:game-log]] all happen on the server. Moving a browser world to the server (and back) is coming in a later 1.5 change.
- **Closing the page pauses the world at once** and saves it. The server keeps it ready: open the game again and pick the same world, and it carries on from where it was, at the fast-forward speed it had. Picking another world lets it go (it was already saved).
- **A hidden tab doesn't pause it.** With the simulation in the page or in a worker, hiding the tab pauses the game. On the server it keeps going while the page is open, so you can watch the debug screen on another monitor. The pause menu still pauses it.
- **One page plays at a time.** A second page opened while one is playing runs its own simulation, as it would without a server.
- **The debug screen reads the world from the server**, so it keeps showing the world (paused) after the page is closed.
- **If the server stops** (Ctrl+C, or a crash), the page says "World server stopped" and shows the game log's last lines. Ctrl+C saves every world first.

## Switching it on

For now the world server is switched on by adding `?sim=server` to the game's address (http://localhost:8000/?sim=server). Without it the game runs as it did before; `?sim=worker` puts the simulation in a background thread of the page instead (see [[page:performance-meter]]). The F3 overlay's last lines say where the simulation is: `Simulation: server`, `Simulation: worker` or `Simulation: in page`. A game opened as a file, or the online version, has no server, so it uses a worker or the page.

`./run.sh --lan` makes the game, the debug screen and the world server reachable from other machines on your network; without it they only answer on this machine. `./run.sh --saves <folder>` keeps the server's worlds somewhere else, and `./run.sh --no-world` starts no world server.
