# Simulation/client protocol

Spec r15-36 (release 1.5). Code: `js/protocol.js`. Test: `test/protocol.js`.

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
| `blockChanges` | `tick`, `chunks`: [[key, [[index, id], ...]], ...] | every flush with changes, all chunks in one message; a cell changed several times goes once with its last id |
| `entities` | `tick`, `add` [{n, kind, s}], `set` [{n, kind, s}], `gone` [n] | every flush after a tick ran, even with nothing changed (every tick at 1x, the latest state at fast-forward); after a request applied; every flush while frozen or paused |
| `events` | `tick`, `list` (js/fx.js effect events: puff, heart, crumbs, dust; r15-37: `sound` entries, below) | every flush with events in view |
| `village` | `list` [{key, name, x, z, people}], `gone` [key] | when a summary changes (checked every 20 flushes that ticked) |
| `clock` | `tick`, `day`, `time`, `speed`, `frozen`, `achieved`, `weather` (only when it changed) | once a game second, and on a speed change |
| `log` | `list` (game log entries, as js/gamelog.js keeps them) | every flush with new entries |
| `result` | `rid` (a request), `qid` (a query) or `sid` (a save), `result`; `tick` for requests | the answer to a client message |

### Encodings

- **chunk**: `b` is a Uint16 stream with one record per section, `lo` to `hi - 1`:
  - `[0, id]`: the whole section is one block;
  - `[1, 4096 ids]`: raw, index `(ly << 8) | (lz << 4) | lx`, as `c.secs` in js/world.js;
  - `[2, runs low 16 bits, runs high 16 bits, (count - 1, id) * runs]`: run-length, used when it is smaller than raw.
- **blockChanges**: `index` is the chunk's edit index, `((y - MIN_Y) * 16 + lz) * 16 + lx`, as in `world.edits`. `b` holds the
  indices as Uint32, then the ids as Uint16, in chunk order. `h` has the keys and how many cells each has.
- **entities**: `n` is the entity's protocol number. It is given by the simulation end and stays the same while the entity lives. A
  new entity comes in `add` with every field, as JSON. A changed one comes in `set` with only the fields that changed:
  - hot fields as float32 in `b`: per entity a Uint32 `n`, a Uint32 with the kind in the top 8 bits and a bitmask of the hot fields
    below, then a float32 for each bit set;
  - cold fields as JSON in `h.cold` [[n, kind, {fields}]].

### Entity fields

| Kind | Hot (float32) | Cold (JSON) |
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
| `query` | `qid`, `what`, `args` | answers with a `result`. Kinds: `villager` {id} (hover card: name, profession, status), `village` {key, n} (summary and newest log lines), `hash` (the r15-24 state hash and parts), `stats` (protocol figures); r15-37: `chest` {x, y, z} (slots, owner label, locked), `trades` {id} (offers with why one can't be done now and the stock, the villager's inventory, level, xp, name, status, editable), `inventory` {id} (a mob's slots), `map` {item, ver} (a normal map's bounds, and its RGB565 pixels as base64 when ver is not the latest), `f3` {x, y, z} (the F3 overlay's simulation figures), `vpanel` {x, z, n} (the F3 village panel: tally, occupations, free job blocks, newest log lines). Add more in `BF.proto.queries` |
| `speed` | `speed` (0 freezes, else one of `BF.warp.SPEEDS`) | sets the fast-forward speed |
| `save` | `sid` | saves the world now (js/save.js), answers `{ok}` |

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
js/mapview.js (the `map` query), and the chest and trade screens of js/inventory.js (`chest` and `trades`, asked again four times a
second while open; "Waiting for the world..." when the first answer takes over 300 ms). Chunk meshing, light and the player's physics
read BF.world: the simulation's in the page, a replica fed by `chunk` and `blockChanges` in a worker (r15-38).

The player's requests go through it: `BF.req.player` calls `BF.client.request`, the simulation applies the request, and its block
changes and result come straight back, so the edit is in the mirror before the call returns. Requests made while one is being applied,
and replayed ones, apply directly.

`BF.proto.check()` compares the mirror with the simulation right after a flush: chunks (bands, blocks, a hash of both sides) and
entities (the set in view, every field, hot fields within 1/256). `BF.proto.stats()` counts messages and bytes by type in each direction.

## Not in the protocol yet

- Block light and sky light: the client gets blocks only. Drawing from the mirror (r15-37) needs light computed on the client or a
  light message.
- Client-side prediction with rollback: in the page the request applies before `request()` returns, so nothing is predicted. Across a
  worker or a socket (r15-38, r15-41) the client keeps its prediction until the `result` arrives.
- The player's own state (inventory, health, game mode) as a message: r15-38 (`self`).
