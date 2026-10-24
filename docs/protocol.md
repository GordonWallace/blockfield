# Simulation/client protocol

Spec r15-36 (release 1.5), with the worker's messages from r15-38. Code: `js/protocol.js`. Tests: `test/protocol.js`, `test/sim-worker.js`.

The protocol is the set of messages between the simulation and the client that draws it. The same messages will carry the in-page
game (now), the simulation in a Web Worker (r15-38), the Node world server (r15-41) and, later, multiplayer.

Protocol version: **1** (`BF.proto.VERSION`, sent in `hello`).

## Packets

Every message is a plain object `{t: type, ...}`. `BF.proto.encode(msg)` turns it into a packet `{h, b}`:

- `h` is a JSON string;
- `b` is an `ArrayBuffer` or `null`. Only `chunk`, `blockChanges` and `entities` have one (bulk data).

`BF.proto.decode(packet)` gives the message back. A packet is what crosses a thread or a socket, and `b` can be transferred.
`BF.proto.bytes(packet)` is its size: the UTF-8 length of `h` plus `b`'s length.

## Simulation to client

| Type | Fields | When |
|---|---|---|
| `hello` | `v` (protocol version), `version` (game version), `seed`, `tick`, `settings` {gen, villages, biomeScale, gameMode} | on connecting, and when a new world starts (the client clears its mirror) |
| `chunk` | `key`, `cx`, `cz`, `lo`, `hi` (section range), `secs` | a loaded chunk comes into view (at most 16 a flush); again whole when it is reloaded or its band of sections grows |
| `unload` | `keys` | chunks the client has that left the view or were unloaded |
| `blockChanges` | `tick`, `chunks`: [[key, [[index, id], ...]], ...] | every flush with changes, all chunks in one message; a cell changed several times goes once with its last id. Replica: every chunk's changes, not only those the client has |
| `edits` | `tick`, `chunks` (as blockChanges) | replica only: every edit the world holds (`world.edits`), at the first flush after each `hello`; it replaces the client's |
| `entities` | `tick`, `add` [{n, kind, s}], `set` [{n, kind, s}], `gone` [n] | every flush after a tick ran, even with nothing changed (every tick at 1x, the latest state at fast-forward); after a request applied; every flush while frozen or paused |
| `events` | `tick`, `list` (js/fx.js effect events: puff, heart, crumbs, dust; r15-37: `sound` entries, below) | every flush with events in view |
| `village` | `list` [{key, name, x, z, people}], `gone` [key] | when a summary changes (checked every 20 flushes that ticked) |
| `clock` | `tick`, `day`, `time`, `speed`, `frozen`, `achieved`, `weather` (only when it changed) | once a game second, and on a speed change |
| `log` | `list` (game log entries, as js/gamelog.js keeps them) | every flush with new entries |
| `self` | `tick`, and only what changed: `inv` (the player's slots, js/playerinv.js `own()`), `cursor` (the stack held by the pointer {id, count, wear?} or null), `screen` (the open screen or null: {mode, target ({x, y, z} of a chest or furnace, {id} of a villager, or null), grid, result, pay, offer (the chosen offer's index), tradeResult}, stacks as {id, count, wear?}); replica also: `hurt` [{a (half-hearts), from [x, y, z] or null, cause} or {kill: true}], `health`, `hunger`, `gameMode`, `pos` [x, y, z] (the simulation moved the player; not while riding), `spawn`, r15-44 part 2: `mount` (what the player rides, or null when they got off: {id, kind "boat" or "horse", steer ("page": the client drives its own copy, "sim": the simulation drives it), pose {x, y, z, yaw}, and the kind's riding figures: a boat's wood, sitEye and passenger type (pass); a horse's seat, sitEye, hp, max, tamed, saddle, speed, jump, hw, h, k}) | every flush and with each request's result, when one of them changed: `inv`, `cursor` and `screen` in every mode (r15-44), the rest when the client keeps a replica |
| `result` | `rid` (a request), `qid` (a query), `sid` (a save) or `wid` (a world), `result`; `tick` for requests | the answer to a client message |

### Encodings

- **chunk**: `b` is a Uint16 stream with one record per section, `lo` to `hi - 1`:
  - `[0, id]`: the whole section is one block;
  - `[1, 4096 ids]`: raw, index `(ly << 8) | (lz << 4) | lx`, as `c.secs` in js/world.js;
  - `[2, runs low 16 bits, runs high 16 bits, (count - 1, id) * runs]`: run-length, used when it is smaller than raw.
- **blockChanges**: `index` is the chunk's edit index, `((y - MIN_Y) * 16 + lz) * 16 + lx`, as in `world.edits`. `b` holds the
  indices as Uint32, then the ids as Uint16, in chunk order. `h` has the keys and how many cells each has.
- **entities**: `n` is the entity's protocol number. It is given by the simulation end and stays the same while the entity lives. A
  new entity comes in `add` with every field, as JSON. A changed one comes in `set` with only the fields that changed:
  - hot fields in `b`, little-endian: per entity a Uint32 `n`, a Uint32 with the kind in the top 8 bits and a bitmask of the hot fields
    below, then for each bit set a float64 for x, y, z (float32 resolves only 0.25 of a block at planet coordinates, about 2.2
    million) and a float32 for the rest;
  - cold fields as JSON in `h.cold` [[n, kind, {fields}]].

### Entity fields

| Kind | Hot (x, y, z float64, the rest float32) | Cold (JSON) |
|---|---|---|
| `mob` | x, y, z, yaw, headYaw, headPitch, walkPhase, walkAmt, age, deathT, fuse, swingT (an arm or tool swing), doorT (a zombie's time at a door) | type, sid (the r15-13 id), look, scale, headScale, partVis (text: name and 1/0 per part), tint, held, onFire, sleeping, bedF (bed facing), crackStage, badgeLevel, dead, onGround, riding, rider (protocol numbers), child; r15-37: hw, h (half width, height), k (a horse's size), golem, aiming (a skeleton's bow), trading, doorAt ([x, y, z] or null), name and prof (villagers), lead (a horse's: "player", the holder's number, or the fence post [x, y, z]) |
| `drop` | x, y, z, age | item, count, phase, pulled |
| `arrow` | x, y, z, lx, ly, lz (the way it points) | stuck |
| `boat` | x, y, z, yaw, hurtT | wood, row, rowing, mob (its passenger's number), rider (the player's own boat) |
| `bee` | x, y, z, yaw | phase, mode, land ([x, y, z, nx, ny, nz]: the spot and the surface's normal, or null), landYaw |

## Client to simulation

| Type | Fields | What the simulation does |
|---|---|---|
| `request` | `rid`, `tick`, `kind`, `target`, `data` | applies the r15-20 player request at once (`BF.req.applyPlayer`), sends its block changes, then a `result` |
| `view` | `x`, `y`, `z`, `dist` (chunks), `budget` (optional: chunks a flush) | decides what is sent: chunks and entities within `dist` chunks of the view's chunk |
| `query` | `qid`, `what`, `args` | answers with a `result`. Kinds: `villager` {id} (hover card: name, profession, status), `village` {key, n} (summary and newest log lines), `hash` (the r15-24 state hash and parts), `stats` (protocol figures), `chunkHash` {keys} (a hash of those chunks' blocks, for a client checking its copy), `feed` {ack} (the simulation's part of a debug feed snapshot, in the worker: js/debugfeed.js); r15-37: `chest` {x, y, z} (slots, owner label, locked), `trades` {id} (offers with why one can't be done now and the stock, the villager's inventory, level, xp, name, status, editable), `inventory` {id} (a mob's slots), `map` {item, ver} (a normal map's bounds, and its RGB565 pixels as base64 when ver is not the latest), `f3` {x, y, z} (the F3 overlay's simulation figures), `vpanel` {x, z, n} (the F3 village panel: tally, occupations, free job blocks, newest log lines); r15-44: `furnace` {x, y, z} (slots [input, fuel, output], burn, burnMax, cook, can: whether it can smelt now; `{}` for the open screen's furnace); r15-44 part 2: `entity` {id} (a boat or mob as the simulation has it: x, y, z, yaw, ridden by the player, hp, a horse's tamed, saddle and lead; for tests). Add more in `BF.proto.queries` |
| `speed` | `speed` (0 freezes, else one of `BF.warp.SPEEDS`), `pause` (optional: the page's menus or a hidden tab stop the ticks without changing the speed) | sets the fast-forward speed |
| `save` | `sid` | saves the world now (js/save.js), answers `{ok}` |
| `player` | the player's body as `BF.player.serialize()` gives it: `x`, `y`, `z`, `yaw`, `pitch`, `health`, `hunger`, `saturation`, `exhaustion`, `air`, `gameMode`, `flying`, `dead`; r15-44: `sel` (the hotbar slot, which is the page's); r15-44 part 2: `ride` {id, x, y, z, yaw, vel [x, y, z], rowing? (a boat's paddles), fall? (half-hearts a horse took landing)}, the boat or horse the client steers, which the simulation puts there | replica: when it changed, at most once a frame. The simulation moves its player there; it is the baseline `self` compares against |
| `world` | `wid`, `op` (`demo`, `create`, `load`), `args` ({seed, opts} / {seed, opts, meta} / {id}, and `rivers`: the page's solved river network, js/worldgen.js `riverState()`) | starts a world with the host's handler (the worker's), answers `{ok, meta?}` when it is ready |
| `meta` | `id`, `name` and / or `monsters` | the open world was renamed or its monster options changed on the title screen |
| `clientLog` | `list` (game log entries) | the client's own log entries (its errors), into the simulation's log, which is the one saved |

### Inventory entries (r15-44)

The events message also carries what the inventory screens show besides their slots (js/invscreen.js plays them): `{kind: "toast", id, n}`
(+n of an item: a pickup, a shift-craft, a shift-trade), `{kind: "levelUp", id}` (the villager of the open trade screen went up a level: the
level flashes), `{kind: "flashName"}` (the held item's name over the hotbar, after a creative pick-block). The simulation raises them as bus
events (`invToast`, `villagerLevelUp`, `invFlashName`); the sim end turns them into entries.

### Sound entries (r15-37)

The simulation's sound cues are bus events (`BF.emit`). The sim end turns each into an `events` entry `{kind: "sound", ev, ...}` and
js/audio.js plays it at the client: `blockBroken`, `blockPlaced`, `blockHit` {x, y, z, id}; `playerEating`, `playerAte`,
`playerDamaged`, `villagerLevelUp`, `gameModeChanged`, `worldLoaded` {}; `mobHurt`, `mobKilled`, `villagerTrade` {x, y, z, type, h, n};
`mobExploded`, `arrowShot`, `chestOpened`, `chestClosed`, `doorBroken` {x, y, z}; `door` {x, y, z, open} (js/world.js setDoor, wrapped
by the sim end); `lightning` {lx, lz, dist} (not limited to the view). The page's own sounds (footsteps, ambience, a mob's calls, a
creeper's fuse, a golem's steps) come from polling the player and the mirror's entities.

## Interest and rate

- The simulation end sends only what the view covers: the loaded chunks within `dist` chunks of the view's chunk (canonical chunks,
  across face edges), and the entities, effects and block changes in those chunks.
- Everything is sent by `flush()`, once a drawn frame after the frame's ticks (js/main.js). Entities are sent only when a tick ran
  since the last flush, so at 1x every tick (a frame holds at most one) and at fast-forward the latest state, once a frame.

## The worker transport and the replica (r15-38)

`js/simhost.js` starts `js/simworker.js` and connects `BF.proto.worker` (the page's end: packets posted with `b` transferred). The
worker serves with `BF.proto.host(send, {replica: true, world, onView})`. With `replica` the client keeps its own copy of the world in
`BF.world` (js/world.js `replica`): it generates and lights its chunks itself, and the simulation sends every edit (`edits` on joining,
`blockChanges` for every chunk after), which `BF.world.applyEdits` writes into its chunks without any of setBlock's consequences (the
simulation makes those and sends them as edits too). No light message is needed: the client works its light out from the blocks.

The page owns the player's body. It sends `player` when it changed; the simulation sets its player there, and its mobs, bees and
lightning hurt the player by `self.hurt` instead of directly. What requests do to the player (eating, the inventory, teleports, the
spawn point) comes back in `self`. Requests are answered later than they are sent; js/player.js goes on as if they worked.

The worker owns the world state and saves it (js/save.js runs there too). The page's `BF.save.create` / `load` set up its copy
(`restoreClient`) and send `world`; `saveNow` sends `save`.

## The in-page transport and the mirror

`BF.proto.local.connect()` (at boot, js/main.js) joins a simulation end and a client end in the page with a direct queue. Each packet
is encoded, delivered at once and decoded. The client end, `BF.client`, keeps a mirror in `BF.client.world`:

- `chunks`: key to {cx, cz, key, lo, hi, secs}, with `getBlock(x, y, z)`;
- `entities`: n to {n, kind, ...fields, prev, pt, ct}: the current fields are from tick `ct`, `prev` holds the hot fields as of tick `pt`.
  An entity missing from a tick's message stood still in it, so when ticks come one by one `pt` is `ct - 1`. `world.k(e, alpha)` is how far
  to draw from `prev` to the current fields: alpha when `e` changed in the latest tick from the tick before, else 1 (r15-37);
- `villages`, `clock`, `log` (the newest 500 lines), `tick`, `gen` (counts `hello` messages: a new world).

`BF.proto.listen(fn)` calls fn(list) for every `events` message (js/entityview.js plays the effects, js/audio.js the sounds).

## What draws from it (r15-37)

The page's render and UI files read the mirror, queries and events, never the simulation (test/client-lint.js keeps the list):
js/mobview.js and js/entityview.js (entities), js/audio.js (sound entries, mobs near the listener), js/villagerhover.js (the mirror's
mobs, the `villager` query), js/villagepanel.js (names over villagers, the `vpanel` query), js/debugoverlay.js (F3, the `f3` query),
js/mapview.js (the `map` query), and the inventory screens, js/invscreen.js (r15-44): the hotbar and every screen's slots from `self` (`inv`,
`cursor`, `screen`), a chest, a villager and a furnace from the `chest`, `trades` and `furnace` queries (asked again four times a second while
open; "Waiting for the world..." when the first answer takes over 300 ms), toasts and the level-up flash from events. Every click, drag,
offer, trash, open and close is a player request (`player.screen`, `player.click`, `player.drag`, `player.offer`, `player.trash`) that
js/playerinv.js applies wherever the simulation runs. A screen the simulation opens (the trade screen) or closes (its chest broken) arrives
in `self.screen` and the page follows, unless a screen request of its own is still on its way. Chunk meshing, light and the player's physics
read BF.world: the simulation's in the page, a replica fed by `chunk` and `blockChanges` in a worker (r15-38).

Riding (r15-44 part 2): getting on and off a boat or horse are player requests, `player.mount` {id} (the simulation checks the seat and the
horse rules, answers with the riding figures and sends `self.mount`) and `player.dismount` {stay?} (the simulation lets a boat's passenger
out and puts the player beside it; `self.pos` says where). Whoever steers moves the vehicle, as for the player's body: with the simulation
in a worker the page rows a boat and rides a saddled, tamed horse with its own copy (js/boats.js / js/horses.js `localCopy`, the same
`drive`), reports it in the player message's `ride`, and draws the mirror's boat or horse where its copy is. An untamed horse steers
itself: the simulation drives it (js/player.js `simRide`, every worker loop) and throws the player off; the page seats them on the mirror's
horse. A boat broken or a horse dead, unloaded or under water puts the player off on the simulation's side, which arrives as `self.mount`
null. The ride is saved with the boat or horse on the simulation's side and comes back as `self.mount` on load.

The player's requests go through it: `BF.req.player` calls `BF.client.request`, the simulation applies the request, and its block
changes and result come straight back, so the edit is in the mirror before the call returns. Requests made while one is being applied,
and replayed ones, apply directly.

`BF.proto.check()` compares the mirror with the simulation right after a flush: chunks (bands, blocks, a hash of both sides) and
entities (the set in view, every field, hot fields within 1/256). `BF.proto.stats()` counts messages and bytes by type in each direction.

## Not in the protocol yet

- Block light and sky light are not sent: the client works them out from the blocks (with the simulation in a worker, the page's
  copy of the world lights itself, r15-38).
- Client-side prediction with rollback: in the page the request applies before `request()` returns, so nothing is predicted. Through
  the worker (r15-38) js/player.js treats a request as done when sent; the edits and inventory that follow come from the simulation.
