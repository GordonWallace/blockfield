// @ci baseline suite=village
// A village record's coops and pens (js/poultry.js coopsOf, js/shepherd.js pensOf) are a list each copy fills in when it first asks,
// and again when a builder finishes one: the state hash (js/statehash.js) counts only those with stock, so two copies that asked at
// different times hash alike (Gordon's test4 with cluster workers, 2026-10-29: the owner of a village it never asked about had
// _coops=[] where the others had its two built coops, empty, and the copies were stopped as different). A stocked one still counts.
const path = require('path');
globalThis.BF = { mobs: { list: [], villages: new Map() } };
require(path.join(__dirname, '..', 'js', 'statehash.js'));
const H = BF.stateHash;
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fails++; };
const coop = (rec, idx, o) => Object.assign({ kind: 'coop', key: rec.key + '|' + idx, idx, gen: false, rec, x0: 1, z0: 1, x1: 4, z1: 4, y: 64, cells: 9, hens: null, eggs: 0 }, o);
const rec = (coops, pens) => { const r = { key: '10,20', members: [], pop: 3 }; if (coops) r._coops = coops(r); if (pens) r._pens = pens(r); return r; };
const hashOf = r => { BF.mobs.villages = new Map([[r.key, r]]); return H.text('villages'); };
const asked = hashOf(rec(r => [coop(r, 'b3'), coop(r, 'b4')], r => [{ kind: 'pen', idx: 'b5', key: r.key + '|b5', rec: r, sheep: null }]));
ok(asked === hashOf(rec(r => [])) && asked === hashOf(rec()), 'empty coops and pens hash alike, filled in or not');
const stocked = hashOf(rec(r => [coop(r, 'b3', { hens: [{ mobId: 'e1', age: 2 }] }), coop(r, 'b4')]));
ok(stocked !== asked, 'a coop with hens counts');
ok(hashOf(rec(r => [coop(r, 'b3', { eggs: 2 })])) !== asked, 'a coop with eggs counts');
ok(hashOf(rec(null, r => [{ kind: 'pen', idx: 'b5', key: r.key + '|b5', rec: r, sheep: [{ mobId: 'e2' }] }])) !== asked, 'a pen with sheep counts');
console.log(fails ? fails + ' FAILED' : 'all ok');
process.exit(fails ? 1 : 0);
