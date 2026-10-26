---
title: Commands
category: Game rules
---
Commands let you change the world and yourself. They are meant for building, testing and recovering from mistakes, and they work in survival as well as creative.

## Using the command line

- Press `/` (or the numpad `/`) while playing to open the command line with a slash already typed. Press `T` to open it empty; plain text is shown as a chat line.
- Enter runs the command, Esc cancels. Up and Down recall the last 30 commands.
- Tab completes command names, item and block names, mob types and coordinates; Shift+Tab cycles back. A hint line above the box shows the syntax.
- While it is open, keys go to the box and not to the game. Replies appear in a log that fades after 10 seconds.
- Bad input prints an error or the usage line. Commands never crash the game.

**Coordinates** can be plain numbers, `~` for your position, or `~5` for five blocks from it. Item names can be written with or without a `minecraft:` prefix, and some familiar vanilla names such as `grass_block`, `oak_planks` and `cooked_beef` also work.

**Cheats.** Using any command other than `/help`, `/seed` and `/say` marks the saved world as having used cheats.

## List of commands

- `/help [command]`: Lists the commands, or shows one command's syntax. `/?` does the same.
- `/tp <x> <y> <z> [yaw] [pitch]`: Teleports you. Height must be within the world. Also `/teleport`.
- `/tp <x> <z>`: Teleports you to the surface at that spot: on top of whatever is highest there, so on the water over a sea or lake, on sea ice, on a tree's leaves or on a roof. Ground that is not loaded yet is generated first, so the height it reports is where you land.
- `/time set <day|noon|sunset|night|midnight|sunrise|ticks>`: Sets the time of day.
- `/time add <ticks>`: Moves the clock on, rolling over into new days.
- `/time query <daytime|day|gametime>`: Prints the time of day in ticks, the day number, or the total time.
- `/gamemode <survival|creative>`: Switches game mode. `s`, `c`, `0` and `1` also work, and so does `/gm`. Adventure and spectator are not available.
- `/give <item> [count]`: Gives you items, up to 2304 at once. What does not fit is dropped at your feet.
- `/clear [item] [maxCount]`: Empties your inventory, or removes only one item. A max count of 0 just counts.
- `/summon <mob> [x y z]`: Creates a mob at your feet or at the position. Any mob type works, from pig to iron_golem and horse.
- `/summon villager <x y z> <profession>`: Creates a villager with that profession, or `child` or `baby` for a child.
- `/kill`: Kills you. `/kill @s` does too.
- `/kill <@e|mobs|hostile|passive|items|type>`: Kills every mob, only hostile or only passive ones, removes dropped items, or kills mobs of one type. Never kills you. `@e[type=zombie]` also works.
- `/weather <clear|rain|thunder> [duration]`: Changes the weather. Duration is in seconds, or with a unit such as `600t` or `1d`.
- `/seed`: Shows the world's seed.
- `/spawnpoint [x y z]`: Sets your respawn point, by default where you stand. Also `/setworldspawn`.
- `/setblock <x> <y> <z> <block> [replace|keep|destroy]`: Places one block. `keep` only fills air; `destroy` drops the old block as if mined.
- `/fill <x1> <y1> <z1> <x2> <y2> <z2> <block> [mode]`: Fills a box with a block, at most 32768 blocks.
- `/locate village`: Reports the nearest village, its name and distance.
- `/heal [amount]`: Restores health: full by default, or the number of half-hearts you give.
- `/feed`: Fills your hunger and saturation.
- `/say <message>`: Prints a message.

### Details

**Time.** A day is 24000 ticks. Tick 0 is sunrise at 6:00, 6000 is noon, 12000 sunset and 18000 midnight. The named times are day (1000), noon (6000), sunset (12000), night (13000), midnight (18000) and sunrise (23000). Units are `t` for ticks, `s` for seconds and `d` for days.

**Fill modes.** `replace` (the default) replaces everything, and takes an optional block to replace, as in `replace stone`. `keep` replaces only air. `hollow` fills the outer shell and clears the inside. `outline` fills the shell and leaves the inside as it was. All the chunks involved must be loaded.

**Weather.** See [[page:time-and-weather]]. **Game modes.** See [[page:player]]. **Mobs.** See [[page:mobs]].
