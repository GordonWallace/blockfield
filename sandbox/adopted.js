// Sandbox textures adopted for every world (spec idea-052): written by the local server (debug/texture.js) from sandbox/adopted.json
// when a texture is adopted or unadopted in the texture studio. Each entry overrides one tile by name (js/textures.js paintTile), the
// way js/faithful.js does: {tile: {rgba: base64 32x32 RGBA, texture, block, face}}. Commit this file with adopted.json to keep them.
globalThis.BF = globalThis.BF || {}; BF.adoptedTextures = {};
