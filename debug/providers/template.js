// Texture studio provider template (spec idea-052): copy this file to debug/providers/<name>.js to add another company's image
// model. debug/texture.js loads every .js file here (this one is skipped: its name is "template"). Keep the key on the server: read it
// from an environment variable or a file outside the checkout, never from the page.
//
// texture(input, ctx) gets:
//   input: { request, tile (base64 32x32 RGBA bytes), screenshot (base64 PNG, a close-up of the block, or null), history: [earlier
//            requests on this tile], face ("top" | "side" | "bottom" | "all"), block (the block's name), tileName, tinted (null, "grass"...) }
//   ctx:   { model (the panel's choice, one of models), tilePng (the tile as a base64 PNG, 8x enlarged), feedback (the problems with your
//            last answer when the server asks again, else null), meter (debug/claude.js: caps and costs; cost(usage, price) helps) }
// and returns one of:
//   { kind: "image", png: <Buffer or base64 PNG, any size>, notes }   fitted to 32x32 by the server (downscale, palette, tileable edges)
//   { kind: "grid", palette: [{symbol, color: "#rrggbb" | "#rrggbbaa" | "transparent"}], rows: [32 strings of 32 symbols], notes }
//   { kind: "recipe", steps: [...], notes }                            painted with the game's painters (js/texturestudio.js RECIPE_OPS)
//   { kind: "refused" } or { kind: "error", error }
// plus log: { system, params, messages, reply: {content, usage, stop_reason}, ms, cost (dollars, for the spend cap and the API calls
// panel) }. Throw for a failed call (network, key rejected); the message is shown in the panel.
"use strict";

const KEY = process.env.EXAMPLE_IMAGE_API_KEY || null;

async function texture(input, ctx) {
  // const r = await fetch("https://api.example.com/v1/images", { method: "POST", headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
  //   body: JSON.stringify({ model: ctx.model, prompt: "A seamless 32x32 pixel-art block texture: " + input.request, size: "256x256" }) });
  // const j = await r.json();
  // return { kind: "image", png: j.data[0].b64_json, notes: "", log: { system: "", params: { model: ctx.model }, messages: [{ role: "user", content: input.request }],
  //   reply: { content: [{ type: "text", text: "[image]" }], usage: {}, stop_reason: "end_turn" }, ms: 0, cost: 0.04 } };
  throw new Error("the template provider does nothing: copy it to a file of its own");
}

module.exports = {
  name: "template", label: "Example image model", models: ["example-image-1"], model: "example-image-1",
  configured: () => (KEY ? true : "no EXAMPLE_IMAGE_API_KEY"),
  texture,
};
