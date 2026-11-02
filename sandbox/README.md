# Sandbox files

Files the sandbox world reads and writes (Blockfieldpedia: "Sandbox worlds").

- `scenes/<name>.json`: scenes, ready-made test worlds. Open one with `localhost:8000/#sandbox=<name>` (a new sandbox world with the scene at spawn), from the Scene list on the New World screen, or with `/scene <name>` inside a sandbox world. The format is described at the top of `js/sandbox.js`.
- `structures/<name>.json`: the structure designer's library (spec idea-051).
- `textures/<name>.png` and `.json`: the texture studio's library (spec idea-052); `adopted.json` lists the textures used in every world.

`scenes/index.json` lists the shipped scenes for pages not served by the run script; `./run.sh` lists the folder itself.
