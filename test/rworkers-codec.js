// @ci baseline suite=world
// The region workers' mob codec (js/rworkers.js: snap, diff, patch), plain node, no browser: node test/rworkers-codec.js
//  - an array's objects that moved (a seller's offers rebuilt in a new order, js/market.js sync) reach the other workers as moves: their
//    own objects change places, so a link into one (a buyer's deal.offer) still points at an object in the list (r15-39b C7)
//  - a moved object changed inside, a new object, a dropped one and a shorter list all come out like the owner's
const { load } = require('../tools/headless.js');
for (const k of ['log', 'info', 'debug']) console[k] = () => {};
const { BF } = load();
const out = s => process.stdout.write(s + '\n');
const RW = BF.rworkers;
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; out("FAIL " + msg); } else out("ok   " + msg); };
RW.refs();
const offer = (id, n) => ({ sell: { id, n }, buy: [{ id: 4144, n: 1 }], times: 0 });
const seller = { id: "x1", trades: [offer(1, 2), offer(2, 3), offer(3, 4), offer(4, 5)] };
const replica = RW.dec(RW.enc(seller));
const deal = { offer: replica.trades[2] };   // (a buyer's deal on the other worker, pointing at its own copy of offer 3)
const s = RW.snap(seller);
const [a, b, c, d] = seller.trades;
seller.trades = [c, a, offer(9, 1), b];   // rebuilt: offer 3 first, offer 4 dropped, a new one
c.times = 1;
const ops = RW.diff(seller, s);
RW.patch(replica, ops);
const same = JSON.stringify(RW.enc(seller)) === JSON.stringify(RW.enc(replica));
ok(same, "the replica's offers are the owner's after the rebuild");
ok(replica.trades[0] === deal.offer && deal.offer.times === 1, "the buyer's deal points at the moved offer, in the list, changed inside");
ok(!replica.trades.includes(undefined) && replica.trades.length === 4, "a new offer and a dropped one: 4 offers");
// and again, from the shadow brought up to date
seller.trades = [b, c];
const ops2 = RW.diff(seller, s);
RW.patch(replica, ops2);
ok(JSON.stringify(RW.enc(seller)) === JSON.stringify(RW.enc(replica)) && replica.trades[1] === deal.offer, "a second rebuild, shorter: the same, and the deal's offer moved with it");
ok(!RW.diff(seller, s), "nothing changed: no ops");
out(fails ? "FAIL rworkers-codec (" + fails + ")" : "PASS rworkers-codec");
process.exit(fails ? 1 : 0);
