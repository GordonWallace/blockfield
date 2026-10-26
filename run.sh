#!/usr/bin/env sh
# Starts Blockfield: the game on http://localhost:8000 and the debug screen on http://localhost:8001,
# and Blockfieldpedia (the wiki, wiki/) on http://localhost:8000/wiki/.
# With them the world server (server/world.js): the game's simulation in Node, the page its client (open ?sim=server).
# Extra options go to debug/server.js (--game <port>, --debug <port>, --lan, --saves <dir>, --no-world, --workers <n>, --coarse on|off). Needs Node.js.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Blockfield needs Node.js to run the game and debug servers: https://nodejs.org" >&2
  exit 1
fi
exec node debug/server.js "$@"
