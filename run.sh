#!/usr/bin/env sh
# Starts Blockfield: the game on http://localhost:8000 and the debug screen on http://localhost:8001.
# Extra options go to debug/server.js (--game <port>, --debug <port>, --lan). Needs Node.js.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Blockfield needs Node.js to run the game and debug servers: https://nodejs.org" >&2
  exit 1
fi
exec node debug/server.js "$@"
