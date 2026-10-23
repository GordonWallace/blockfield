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

**Coordinates** can be plain numbers, `~` for your position, or `~5` for five blocks from it. They are `u y v` on the face you are standing on (see [[page:the-planet]]), in the same order as x y z. You can go past the face's edges: up to one face width beyond them is the neighbouring face, laid out flat, so `~10` works across an edge, and whatever you place or summon there lands on the right face. Further out than that is off the planet. Replies give places as `face 2  u 81,920  v 81,920  y 64`. Item names can be written with or without a `minecraft:` prefix, and some familiar vanilla names such as `grass_block`, `oak_planks` and `cooked_beef` also work.

**Cheats.** Using any command other than `/help`, `/seed` and `/say` marks the saved world as having used cheats.

## List of commands

- `/help [command]`: Lists the commands, or shows one command's syntax. `/?` does the same.
- `/tp <u> <y> <v> [yaw] [pitch]`: Teleports you to a point on the face you are on. Also `/teleport`.
- `/tp <u> <v>`: Teleports you to the surface at that spot.
- There are more ways to say where:
  - `/tp face <0-5> <u> <v> [y]`: to a point on any face, on the surface unless you give a layer.
  - `/tp <lat> <lon> [y]`: to a latitude and longitude, written with their letters, as in `/tp 35.26N 45E` or `/tp 10.5S 120W 2000`.
  - `/tp corner <1-8>`: to one of the planet's eight corners, 40 blocks in from it, 30 above the ground, flying and facing it.
  - `/tp up <blocks>`: straight up, that many blocks above the ground (or sea) where you are, flying. `/tp up 25000` takes you off the planet.
  - `/tp ground`: back down to the surface where you are.
  - A teleport keeps the compass direction you face. A spot past a corner, where no face lies flat, lands on the nearest point.
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
- `/locate village`: Reports the nearest village, its name and distance. On the planet it also gives the compass direction and the `/tp face` command that goes there.
- `/heal [amount]`: Restores health: full by default, or the number of half-hearts you give.
- `/feed`: Fills your hunger and saturation.
- `/say <message>`: Prints a message.

### Details

**Time.** A day is 24000 ticks. Tick 0 is sunrise at 6:00, 6000 is noon, 12000 sunset and 18000 midnight. The named times are day (1000), noon (6000), sunset (12000), night (13000), midnight (18000) and sunrise (23000). Units are `t` for ticks, `s` for seconds and `d` for days.

**Fill modes.** `replace` (the default) replaces everything, and takes an optional block to replace, as in `replace stone`. `keep` replaces only air. `hollow` fills the outer shell and clears the inside. `outline` fills the shell and leaves the inside as it was. All the chunks involved must be loaded.

**Weather.** See [[page:time-and-weather]]. **Game modes.** See [[page:player]]. **Mobs.** See [[page:mobs]].
