// Texture studio provider: Claude (spec idea-052). The default provider. Claude sees the block, the face, the current tile (an 8x
// enlargement) and a close-up of the block in the world, and answers with structured output: a pixel grid (up to 16 colours, 32 rows
// of 32 symbols) or a recipe (steps on the game's own painters, painted by js/texturestudio.js), whichever suits the request.
// The key and the SDK are debug/claude.js's (ANTHROPIC_API_KEY, BF_CLAUDE_KEY_FILE or ~/.config/blockfield/anthropic-key); its caps
// and its API calls panel cover these calls too. Model: BF_TEXTURE_MODEL or the panel, one of debug/claude.js PRICES; default Haiku.
// Interface (debug/providers/template.js): { name, models, model, configured(), texture(input, ctx) -> result }.
"use strict";
const fs = require("fs"), path = require("path");
const claude = require("../claude.js");

const OPS = ["fill", "noise", "stone", "cobble", "bricks", "planks", "bark", "log_top", "leaves", "ore_specks", "moss", "frame", "rect", "pixels", "relief"];
const PROMPT = path.resolve(__dirname, "..", "..", "prompts", "texture-studio.md");
const obj = (props, req) => ({ type: "object", properties: props, required: req || Object.keys(props), additionalProperties: false });
const SCHEMA = obj({
  kind: { type: "string", enum: ["grid", "recipe"] },
  notes: { type: "string" },
  palette: { type: "array", items: obj({ symbol: { type: "string" }, color: { type: "string" } }) },
  rows: { type: "array", items: { type: "string" } },
  steps: { type: "array", items: obj({ op: { type: "string", enum: OPS }, colors: { type: "array", items: { type: "string" } }, amount: { type: "number" },
    x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer" }, h: { type: "integer" }, pixels: { type: "array", items: obj({ x: { type: "integer" }, y: { type: "integer" }, color: { type: "string" } }) } }) },
});
const MODELS = Object.keys(claude.PRICES);
const MODEL = MODELS.includes(process.env.BF_TEXTURE_MODEL) ? process.env.BF_TEXTURE_MODEL : "claude-haiku-5-5";
const TOKENS = 16000, EFFORT = process.env.BF_TEXTURE_EFFORT || "medium";

function system() {
  let t = "";
  try { t = fs.readFileSync(PROMPT, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim(); } catch (e) { /* the fallback */ }
  return (t || "You paint 32x32 block textures for a blocky voxel game. Answer with a pixel grid or a recipe.").replace("{{ops}}", OPS.join(", "));
}
const img = data => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
async function texture(input, ctx) {
  const m = ctx.meter, model = ctx.model || MODEL;
  if (!claude.PRICES[model]) throw Object.assign(new Error("unknown model " + model), { status: 400 });
  const lines = [
    `Block: ${input.block || "?"}. Face: ${input.face || "all"}. Tile: ${input.tileName || "?"}.`,
    input.tinted ? `This tile is tinted by the biome (${input.tinted}): paint it in greys, the game colours it.` : "",
    (input.history || []).length ? "Earlier requests on this tile, oldest first:\n" + input.history.map((h, i) => `${i + 1}. ${h}`).join("\n") : "",
    "The first image is the tile as it is now, enlarged 8 times." + (input.screenshot ? " The second is a close-up of the block in the world." : ""),
    "Request: " + input.request,
    ctx.feedback ? "Your last answer had problems: " + ctx.feedback + "\nSend a corrected answer." : "",
  ].filter(Boolean).join("\n\n");
  const content = [{ type: "text", text: lines }, img(ctx.tilePng)];
  if (input.screenshot) content.push(img(input.screenshot));
  const messages = [{ role: "user", content }], sys = system();
  const t0 = Date.now();
  const r = await m.client().messages.create({ model, max_tokens: TOKENS, output_config: { effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } }, system: sys, messages });
  const log = { system: sys, params: { max_tokens: TOKENS, effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } }, messages: [{ role: "user", content: [{ type: "text", text: lines }, { type: "text", text: "[tile image" + (input.screenshot ? " + screenshot" : "") + "]" }] }],
    reply: r, ms: Date.now() - t0, cost: m.cost(r.usage || {}, claude.PRICES[model]) };
  if (r.stop_reason === "refusal") return { kind: "refused", log };
  if (r.stop_reason === "max_tokens") return { kind: "error", error: "the answer was cut off", log };
  let o = null;
  try { o = JSON.parse((r.content || []).filter(b => b.type === "text").map(b => b.text).join("")); } catch (e) { return { kind: "error", error: "the answer wasn't JSON", log }; }
  if (o.kind === "recipe") return { kind: "recipe", steps: o.steps || [], notes: o.notes || "", log };
  return { kind: "grid", palette: o.palette || [], rows: o.rows || [], notes: o.notes || "", log };
}
module.exports = {
  name: "anthropic", label: "Claude (Anthropic)", models: MODELS, model: MODEL, OPS, SCHEMA,
  configured: () => (!claude.meter.key() ? "no Anthropic API key (see debug/claude.js)" : !claude.meter.sdk() ? "the Anthropic SDK isn't installed: run npm install in debug/" : true),
  texture,
};
