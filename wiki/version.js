#!/usr/bin/env node
// Blockfieldpedia versions (wiki/versions.json, wiki/versions/<id>/). Node only, no packages. See wiki/README.md.
//   node wiki/version.js list            the versions and their status
//   node wiki/version.js new 1.4         a new release starts: copy the newest version's pages (articles, natural.json) to versions/1.4,
//                                        list it first as "development" and set the game's version (js/version.js) to 1.4
//   node wiki/version.js freeze 1.3      the release merged to main: copy the game it documents (index.html and js/) into
//                                        versions/1.3/game/ and mark it "released"; its pages are never edited again
"use strict";
const fs = require("fs"), path = require("path");
const WIKI = __dirname, ROOT = path.resolve(WIKI, ".."), LIST = path.join(WIKI, "versions.json");
const [cmd, id] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(LIST, "utf8"));
const save = () => fs.writeFileSync(LIST, JSON.stringify(data, null, 2) + "\n");
const die = msg => { console.error(msg); process.exit(1); };
const copyDir = (from, to, skip) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip && skip(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
};
if (cmd === "list" || !cmd) {
  for (const v of data.versions) console.log(`${v.id}\t${v.status}`);
} else if (cmd === "new") {
  if (!/^\d+\.\d+$/.test(id || "")) die("usage: node wiki/version.js new <major.minor>");
  if (data.versions.some(v => v.id === id)) die(`version ${id} already exists`);
  const from = data.versions[0];
  if (!from) die("no version to copy from");
  copyDir(path.join(WIKI, "versions", from.id), path.join(WIKI, "versions", id), n => n === "game");   // pages only; a frozen game copy stays with its version
  data.versions.unshift({ id, status: "development" });
  save();
  const vf = path.join(ROOT, "js", "version.js");
  fs.writeFileSync(vf, fs.readFileSync(vf, "utf8").replace(/VERSION = "[^"]*"/, `VERSION = "${id}"`));
  console.log(`versions/${id} copied from ${from.id} (${from.status}); js/version.js is now ${id}`);
} else if (cmd === "freeze") {
  const v = data.versions.find(v => v.id === id);
  if (!v) die(`no version ${id}`);
  if (v.status === "released") die(`version ${id} is already released`);
  const dest = path.join(WIKI, "versions", id, "game");
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "index.html"), path.join(dest, "index.html"));
  copyDir(path.join(ROOT, "js"), path.join(dest, "js"));
  v.status = "released";
  save();
  console.log(`version ${id} frozen: its pages now read versions/${id}/game/`);
} else die("usage: node wiki/version.js list | new <id> | freeze <id>");
