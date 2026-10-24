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
| `entities` | `tick`, `add` [{n, kind, s}], `set` [{n, kind, s}], `gone` [n] | every flush after a tick ran (every tick at 1x, the latest state at fast-forward) |
| `events` | `tick`, `list` (js/fx.js effect events: puff, heart, crumbs, dust) | every flush with events in view |
| `village` | `list` [{key, name, x, z, people}], `gone` [key] | when a summary changes (checked every 20 flushes that ticked) |
| `clock` | `tick`, `day`, `time`, `speed`, `frozen`, `achieved`, `weather` (only when it changed) | once a game second, and on a speed change |
| `log` | `list` (game log entries, as js/gamelog.js keeps them) | every flush with new entries |
| `self` | `tick`, and only what changed: `hurt` [{a (half-hearts), from [x, y, z] or null, cause} or {kill: true}], `health`, `hunger`, `gameMode`, `pos` [x, y, z] (the simulation moved the player), `inv` (the player's slots, js/inventory.js `own()`), `spawn` | replica only: every flush and with each request's result, when the simulation did something to the player |
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
  - hot fields as float32 in `b`: per entity a Uint32 `n`, a Uint32 with the kind in the top 8 bits and a bitmask of the hot fields
    below, then a float32 for each bit set;
  - cold fields as JSON in `h.cold` [[n, kind, {fields}]].

### Entity fields

| Kind | Hot (float32) | Cold (JSON) |
|---|---|---|
| `mob` | x, y, z, yaw, headYaw, headPitch, walkPhase, walkAmt, age, deathT, fuse | type, sid (the r15-13 id), look, scale, headScale, partVis (text: name and 1/0 per part), tint, held, onFire, sleeping, bedF (bed facing), crackStage, badgeLevel, dead, onGround, riding, rider (protocol numbers), child |
| `drop` | x, y, z, age | item, count, phase, pulled |
| `arrow` | x, y, z, lx, ly, lz (the way it points) | stuck |
| `boat` | x, y, z, yaw, hurtT | wood, row, rowing, mob (its passenger's number) |
| `bee` | x, y, z, yaw | phase, mode, land ([x, y, z] or null), landYaw |

## Client to simulation

| Type | Fields | What the simulation does |
|---|---|---|
| `request` | `rid`, `tick`, `kind`, `target`, `data` | applies the r15-20 player request at once (`BF.req.applyPlayer`), sends its block changes, then a `result` |
| `view` | `x`, `y`, `z`, `dist` (chunks), `budget` (optional: chunks a flush) | decides what is sent: chunks and entities within `dist` chunks of the view's chunk |
| `query` | `qid`, `what`, `args` | answers with a `result`. Kinds now: `villager` {id} (hover card: name, profession, status), `village` {key, n} (summary and newest log lines), `hash` (the r15-24 state hash and parts), `stats` (protocol figures), `chunkHash` {keys} (a hash of those chunks' blocks, for a client checking its copy), `feed` {ack} (the simulation's part of a debug feed snapshot, in the worker: js/debugfeed.js). Add more in `BF.proto.queries` |
| `speed` | `speed` (0 freezes, else one of `BF.warp.SPEEDS`), `pause` (optional: the page's menus or a hidden tab stop the ticks without changing the speed) | sets the fast-forward speed |
| `save` | `sid` | saves the world now (js/save.js), answers `{ok}` |
| `player` | the player's body as `BF.player.serialize()` gives it: `x`, `y`, `z`, `yaw`, `pitch`, `health`, `hunger`, `saturation`, `exhaustion`, `air`, `gameMode`, `flying`, `dead` | replica: when it changed, at most once a frame. The simulation moves its player there; it is the baseline `self` compares against |
| `world` | `wid`, `op` (`demo`, `create`, `load`), `args` ({seed, opts} / {seed, opts, meta} / {id}, and `rivers`: the page's solved river network, js/worldgen.js `riverState()`) | starts a world with the host's handler (the worker's), answers `{ok, meta?}` when it is ready |
| `meta` | `id`, `name` and / or `monsters` | the open world was renamed or its monster options changed on the title screen |
| `clientLog` | `list` (game log entries) | the client's own log entries (its errors), into the simulation's log, which is the one saved |

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
- `entities`: n to {n, kind, ...fields, prev}, where `prev` holds the hot fields before the latest update (for interpolation);
- `villages`, `clock`, `log` (the newest 500 lines), `tick`.

The player's requests go through it: `BF.req.player` calls `BF.client.request`, the simulation applies the request, and its block
changes and result come straight back, so the edit is in the mirror before the call returns. Requests made while one is being applied,
and replayed ones, apply directly.

`BF.proto.check()` compares the mirror with the simulation right after a flush: chunks (bands, blocks, a hash of both sides) and
entities (the set in view, every field, hot fields within 1/256). `BF.proto.stats()` counts messages and bytes by type in each direction.

## Not in the protocol yet

- Block light and sky light are not sent: the client works them out from the blocks (with the simulation in a worker, the page's
  copy of the world lights itself, r15-38).
- Sounds: still played by the simulation's modules. r15-37 moves them to events.
- Client-side prediction with rollback: in the page the request applies before `request()` returns, so nothing is predicted. Through
  the worker (r15-38) js/player.js treats a request as done when sent; the edits and inventory that follow come from the simulation.
- Inventories, chests, trade offers and maps: r15-37 adds them as queries.
