---
title: Saving and moving worlds
category: Game rules
---
Blockfield saves the world you are playing every 30 seconds, when you pause, when you choose **Save and Quit to Title**, and when you close the page. After **Save and Quit to Title** the world stays behind the title screen but is no longer saved, wherever the simulation runs. Where the save goes depends on how you started the game.

## Where your worlds are kept

- **Started with `./run.sh` (or `run.cmd`), playing on the [[page:world-server]]:** each world is a folder in `saves/`, next to the game: `saves/<world name>/`. The title screen says *Singleplayer · on the world server* and lists these worlds. Stopping the server with Ctrl+C saves every world first.
- **Opened as a file, the online version, or with `?sim=page` or `?sim=worker`:** in your browser's own storage (IndexedDB), as in earlier releases. Each browser, and each address the game is opened from, has its own list.

A world's folder holds:

- `world.json`: the world's entry in the list (its name, seed, game mode, the save version, the time of day and day number, when it was created and last played). It is plain text, so you can read it.
- `save.v8`: everything else about the world (your edits to the terrain, the player, the villagers and mobs, the weather and the rest).
- `log/`: the world's [[page:game-log]].

The folder is named after the world when it is made. Characters a file name can't hold become `_`, a long name is cut at 60 characters with no dot or space left at the end, names Windows keeps for devices (`CON`, `NUL`, `CON.txt`...) get a `_` after the device part, and a name that is already taken gets ` (2)` added. A world's name is at most 40 characters, whether it was created, renamed or imported. Renaming the world on the title screen renames its folder too; if the world is open on the server at the time, the folder follows when the server next starts. The server finds a world by the id inside its `world.json`, not by the folder name, so you can back a folder up, rename it or copy it into another `saves/` folder (while the server is stopped). `saves/` is not part of the game's files in git.

Saves are written safely: each file is written beside the old one and only then swapped in, so a save that fails (a full disk, say) leaves the previous save as it was. The game then shows *Couldn't save the world* on the action bar with the reason, the pause menu says *Couldn't save*, and the game log has an ERROR line. It tries again at the next autosave.

## Moving worlds

The title screen has three ways to move a world, in every mode:

- **Export**, on a world's row, downloads the world as a single `.bfworld` file (named after the world). The file is the same whether it came from the server or from a browser, and it includes the world's game log.
- **Import world…**, under the list, adds the world in a `.bfworld` file to the list you are looking at: the server's folders, or your browser's storage. If a world with the same id is already there, the imported one becomes a second copy. A damaged file is refused with the reason (*That world file's game log is damaged*, for one whose log names a batch by anything but a number), and nothing of it is kept: an imported world only ever writes inside its own folder.
- **Copy browser saves to the server** appears when you are playing on the world server and this browser has worlds of its own. It copies them all into `saves/`. The browser keeps its copies, and worlds that were copied before are skipped, so pressing it twice does no harm.

To move a world from the server back into a browser, Export it while playing on the server, then open the game without the server (as a file, say) and Import it there.

A world file can be at most 256 MB once unpacked (a world's file is a few MB to tens of MB). A bigger one, or a small file that would unpack to more, is refused with *That world file is too big*, and the server goes on running the game while it checks.

## Older worlds

Blockfield 1.5 can't open worlds made with earlier releases: 1.4's planets and 1.3's flat worlds. They stay in the browser's list, greyed out and marked *Made with Blockfield 1.4, can't be opened in 1.5* (or 1.3), with only a Delete button. Import refuses their files with the same message, and Copy browser saves to the server leaves them behind.

## Only one page at a time

The world server plays one page at a time. A second page opened while one is playing says *World in use* on its title screen. It runs its own simulation and keeps its worlds in that browser, as it would with no server.

## In the game log

Each save is a DEBUG line (kind *save*) with how long it took. A save that failed is an ERROR. Exports, imports, copies to the server and a world that was too old to open are INFO lines. An import that fails is an ERROR with the reason.
