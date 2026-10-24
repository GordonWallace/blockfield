// Where the game is running (spec r15-40): in the page, or headless (Node, a worker), where only the simulation's files load
// (js/simfiles.js) and there is no document, canvas, WebGL or Three.js scene. Sim files check BF.page before touching the page
// (DOM events, document, localStorage), and hook up after every file has loaded with BF.onLoad (the page's load event; headless,
// BF.boot.headless runs them once the files are in).
// API: BF.page (bool), BF.onLoad(fn), BF.runLoadHooks()
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
BF.page = typeof document !== "undefined" && typeof addEventListener === "function";
const hooks = [];
BF.onLoad = fn => { if (BF.page) addEventListener("load", fn); else hooks.push(fn); };
BF.runLoadHooks = () => { while (hooks.length) hooks.shift()(); };
})();
