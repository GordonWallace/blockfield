# Villager trade audit

Generated against `js/trading.js` (value table `BF.trades.VALUE`, tables `BF.trades.TRADES`). Rerun the numbers any time with the same table; the game itself does not use the values, they only document and check the balance.

## Method

- **Unit.** One emerald = 1.00. Values are effort in emerald equivalents for *this* game (mining depth and tool tier needed, mob danger, crafting inputs, furnace/fuel time). Crafted items = sum of inputs + ~5% craft margin.
- **How emeralds enter the game.** There is no emerald ore (`blocks.js`), worldgen places no loot chests (village chests are empty decoration), and mobs drop none. Emeralds exist only as villager payment for goods. So emerald value is "what a villager will give for one emerald's worth of effort", and every trade is priced against the goods, never the other way round. Diamonds (3.5) and gold (1.2) are priced by ore depth/rarity (worldgen veins: coal y<=100, iron y<=64, gold y<=32, diamond y<=16, ~1.4 veins per chunk) and needed tool tier.
- **Margin rule (applied everywhere).** With rho = value received by the player / value given by the player:
  - player **sells goods for emeralds**: rho 0.72 to 0.93 (villager keeps 7 to 28%; typically ~0.9)
  - player **buys wares** (emeralds, optionally plus a trade-in): rho 0.78 to 1.15 (typically ~0.85 to 1.05; bulk cheap goods may be slightly favourable because whole emeralds are coarse)
  - all offers stay inside +-30%; no round trip is profitable: for every item, the best price any villager pays per unit is below the lowest price any villager charges (checked by script, 0 loops).
  - since 1.3 every villager also sells its **spare goods** (anything above what it keeps for its next moves, js/market.js) at the cheapest base price any villager's table charges for the item, or VALUE + 5% when none does, and buys what it **needs** right now at VALUE x 0.88. The furniture maker sells a chest for 1 emerald (what villagers pay to have one put in their house). There are no fair-price deals between villagers any more: every trade is an offer the player can take too.
  - these are **base** prices. Since 1.3 prices follow demand (js/prices.js): a buy offer nobody fills rises up to x2 over 30 game days, a sell offer stuck at its stock cap falls to x0.5, and each filled trade moves it 3 steps (of 2^(1/30)) back. A villager never buys an item above its own sell price for it, never sells below its own buy price, and never buys above the cheapest base price any villager charges. Buying marked-down goods from one villager and selling them to another whose offer has risen can now pay: that is the point (shortages pull goods in), and it is bounded by the seller's stock and the buyer's emerald purse.
- **Stock.** Each villager only holds what its table sells; per-ware cap = offer size x [6,5,4,3,2] by offer level, at most 2 stacks (gear 1-2 pieces) and at most 6 emeralds worth of any single ware. Start quantity is 50 to 100% of cap, plus the goods it buys occasionally (40% chance, small counts) and 6 to 24 emeralds.
- **Daily restock** (once per in-game day, skipped while the trade screen is open): only wares in the profession's `PRODUCE` list rise, by 25% of cap (min 1) per day up to the cap (a gap of several days counts up to 4); emeralds +2 per day up to 12. Diamonds, gold, bells, lanterns, mob drops etc. never regenerate; they return only if the player sells them to that villager.

## Villager food (js/villagelife.js): restock no longer creates food

Villagers now eat 1 bread-equivalent per day (children 2) out of their own inventory and buy food from each other (see CONTRACT.md
"Villager food and farming"). So that food is never conjured from nothing, the daily restock was changed:

- `PRODUCE.farmer` was `bread, apple, baked_potato, hay_bale` and is now empty. Farmers grow wheat, carrots, potatoes and beetroots on the
  village farmland (real blocks, `BF.rollDrops` loot into their inventory), replant from their own seeds and bake 3 wheat -> 1 bread
  (9 wheat -> 1 hay bale once they hold 96+ bread). Apples and baked potatoes exist only as starting stock (no source in the game).
- `PRODUCE.butcher` (cooked chicken/porkchop/steak/mutton) and `PRODUCE.fisherman` (raw and cooked cod) are empty. Instead they cook up to
  8 raw items they hold per day (raw -> cooked, 1:1, conversion only). Their food stock now only grows when the player sells them raw meat.
- Emerald trickle (+2/day up to 12, builders +4 up to 80) is kept: it is what lets non-food villagers pay for their daily bread
  (about 0.24 emerald per day at the farmer's "1 emerald > 4 bread"), so no villager starves for lack of money while the trickle runs.
  The emeralds flow from every villager to the food sellers (farmers, butchers, fishermen), whose emerald count is not capped by trades.
- Villager-to-villager food purchases use the seller's own food offers (`1 emerald > 4 bread`, `> 12 raw_cod`, `> 9 cooked_chicken`, ...)
  through `BF.trades.exchange` (seller xp included); a seller without such an offer charges 1 emerald for ~0.9 emerald of food at `VALUE`
  prices. A seller always keeps 7 bread-eq (farmers additionally 8 of each seed/crop item for replanting).
- New items: `bucket` (3 iron ingots in a V, value ~1.5 = 3 x 0.5) and `water_bucket`; not traded.
- A villager that has had nothing to eat for more than one day only offers its food trades ("Too hungry to trade" on the others).

## Game changes made for the audit

- No new items were added. Three small supply fixes so that the things villagers *ask for* can be obtained: cows drop 0-2 leather (`mobs.js`), recipes 3 sugar cane -> 3 paper and 3 paper + leather -> book (`inventory.js`). Before, paper, books and leather existed only as trade goods nobody could produce.
- Items that still have no source in the game and are therefore only available from villagers: apple, raw/cooked cod. Villagers sell them but never buy them.
- Bows do not stack, so a "2 bow" payment is impossible; the old fletcher bow offers were replaced.

## Items in old offers that do not exist in the game

Dropped (not replaced) because no equivalent exists: iron/diamond armor (iron_helmet, iron_chestplate, iron_leggings, diamond_helmet, diamond_chestplate, leather_tunic, leather_horse_armor), shield, saddle, fishing_rod, shears, bookshelf, compass, clock, map, item_frame, painting, name_tag, ender_pearl, experience_bottle, redstone, lapis_lazuli, glowstone, raw_salmon, sweet_berries, tipped_arrow. Replaced by existing equivalents: `bed` -> `red_bed`, `clay` -> `clay_ball` (the clay block drops balls and cannot be picked up). **Consequence:** the armorer has no armor to sell. It deals in iron ingots, coal, lanterns, gold and diamonds (its metal) until armor items exist; add armor offers to `TRADES.armorer` when they do (iron helmet ~ 5 ingots = 2.5, chestplate ~ 8 ingots = 4.0, diamond chestplate 8 diamonds = 28 in this value scale).

## Value table

### Currency

| Item | Value | Basis |
|---|---:|---|
| emerald | 1 | Currency. No emerald ore, no loot chests: the only source in the game is selling goods to villagers. Defined as 1.00. |

### Farm

| Item | Value | Basis |
|---|---:|---|
| wheat_seeds | 0.025 | Free from grass (8-12%) and every wheat harvest; floor value so bulk seed offers stay sane |
| beetroot_seeds | 0.03 | Free from beetroot harvest |
| wheat_item | 0.07 | Needs hoe + seeds + a growth cycle; 1 per plant |
| potato | 0.06 | Farm crop, 1-3 per plant |
| carrot | 0.06 | Farm crop, 1-3 per plant |
| beetroot | 0.07 | Farm crop |
| baked_potato | 0.09 | Potato + furnace time and fuel |
| bread | 0.24 | 3 wheat + craft (0.21 + 0.03) |
| apple | 0.15 | No source in the game (leaves drop nothing): trade-only; priced like a bread-level food |
| pumpkin | 0.14 | Natural patches; axe helps |
| hay_bale | 0.65 | 9 wheat (0.63) + craft |
| sugar_cane | 0.04 | Grows beside water at sea level; cut by hand |

### Stone, clay, sand, wood

| Item | Value | Basis |
|---|---:|---|
| stick | 0.02 | Planks (a log gives 8 sticks) - cheapest item; priced up a little because tree finding is not free |
| cobblestone | 0.03 | Mined with any pickaxe, ubiquitous |
| stone | 0.05 | Cobblestone + furnace time |
| sand | 0.03 | Shovel, common |
| gravel | 0.03 | Shovel, common |
| clay_ball | 0.06 | Clay block yields 4; shovel, patchy near water |
| brick | 0.15 | Clay ball smelted (0.06 + fuel + time) |
| bricks | 0.62 | 4 brick (0.60) + craft |
| glass | 0.08 | Sand smelted |
| sandstone | 0.08 | Desert block, pickaxe (or 4 sand) |
| sandstone_bricks | 0.09 | Sandstone craft |
| mossy_cobblestone | 0.15 | Cobblestone + moss block, or rare natural |
| calcite | 0.12 | Rare natural block, pickaxe |
| terracotta | 0.15 | Badlands blocks, pickaxe (clay blocks cannot be picked up) |
| orange_terracotta | 0.18 | Badlands bands, pickaxe |
| yellow_terracotta | 0.18 | Badlands bands, pickaxe |
| red_terracotta | 0.18 | Badlands bands, pickaxe |
| white_terracotta | 0.18 | Badlands bands, pickaxe |
| brown_terracotta | 0.18 | Badlands bands, pickaxe |
| chest | 0.26 | 8 planks |
| red_bed | 0.42 | 3 wool + 3 planks |

### Ores and metals

| Item | Value | Basis |
|---|---:|---|
| flint | 0.06 | 10% of gravel digs |
| coal | 0.12 | Common ore (veins to y=100), pickaxe |
| charcoal | 0.1 | Log smelted |
| iron_ingot | 0.5 | Ore (y<=64, needs stone pickaxe) + furnace + fuel |
| gold_ingot | 1.2 | Rare ore (y<=32) + furnace |
| diamond | 3.5 | Rarest ore (y<=16, ~1.4 veins/chunk), needs iron pickaxe |
| lantern | 2.2 | 4 iron ingots + coal (2.00 + 0.12) + craft |
| bell | 6 | Only by breaking the single village bell (hardness 5), no recipe |

### Mob drops

| Item | Value | Basis |
|---|---:|---|
| string | 0.1 | Spider drop (0-2), spiders are dangerous |
| feather | 0.07 | Chicken drop (0-2) |
| bone | 0.08 | Skeleton drop (0-2), night mob |
| rotten_flesh | 0.05 | Zombie drop (0-2) |
| gunpowder | 0.2 | Creeper drop (0-2), explodes |
| arrow | 0.04 | Skeleton drop or craft (flint + stick + feather gives 4) |
| wool | 0.1 | Sheep drop (1) |
| white_wool | 0.12 | Wool converted free (or 4 string) |
| leather | 0.15 | Cow drop (0-2), added in this rework |

### Meat and fish

| Item | Value | Basis |
|---|---:|---|
| raw_porkchop | 0.08 | Pig drop 1-3 |
| raw_beef | 0.08 | Cow drop 1-3 |
| raw_mutton | 0.07 | Sheep drop 1-2 |
| raw_chicken | 0.06 | Chicken drop |
| cooked_porkchop | 0.12 | Raw + furnace + fuel |
| steak | 0.12 | Raw + furnace + fuel |
| cooked_mutton | 0.1 | Raw + furnace + fuel |
| cooked_chicken | 0.1 | Raw + furnace + fuel |
| raw_cod | 0.07 | No fishing in the game: trade-only; priced like other raw meat |
| cooked_cod | 0.1 | Raw + furnace |

### Paper goods

| Item | Value | Basis |
|---|---:|---|
| paper | 0.05 | 3 sugar cane -> 3 paper (recipe added) |
| book | 0.35 | 3 paper + leather (recipe added) |

### Tools

| Item | Value | Basis |
|---|---:|---|
| iron_pickaxe | 1.58 | 3 ingots + 2 sticks + craft |
| iron_axe | 1.58 | 3 ingots + 2 sticks + craft |
| iron_shovel | 0.57 | 1 ingot + 2 sticks |
| iron_sword | 1.07 | 2 ingots + stick |
| iron_hoe | 1.07 | 2 ingots + 2 sticks |
| diamond_pickaxe | 10.6 | 3 diamonds + 2 sticks |
| diamond_axe | 10.6 | 3 diamonds + 2 sticks |
| diamond_shovel | 3.57 | 1 diamond + 2 sticks |
| diamond_sword | 7.05 | 2 diamonds + stick |
| diamond_hoe | 7.07 | 2 diamonds + 2 sticks |
| bow | 0.42 | 3 sticks + 3 string (not traded: bows do not stack) |

## Final trades per profession

Columns: value given by the player, value received, rho (received / given). A villager offers every row up to its level. An offer is clickable only when the villager holds the full `sell` amount and has room for the `buy` items.

### farmer

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 16 wheat_item > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 1 | 18 potato > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 1 | 18 carrot > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 1 | 1 emerald > 4 bread | 1.00 | 0.96 | 0.96 | buy from villager |
| 2 | 16 beetroot > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 2 | 8 pumpkin > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 2 | 1 emerald > 10 baked_potato | 1.00 | 0.90 | 0.90 | buy from villager |
| 3 | 28 sugar_cane > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 3 | 3 emerald > 4 hay_bale | 3.00 | 2.60 | 0.87 | buy from villager |
| 3 | 2 hay_bale > 1 emerald | 1.30 | 1.00 | 0.77 | sell to villager |
| 4 | 1 emerald > 14 wheat_item | 1.00 | 0.98 | 0.98 | buy from villager |
| 4 | 12 baked_potato > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 5 | 1 emerald > 16 carrot | 1.00 | 0.96 | 0.96 | buy from villager |
| 5 | 1 emerald > 16 potato | 1.00 | 0.96 | 0.96 | buy from villager |

Since 1.1 (Gordon) farmers sell only crops and food baked from them: the apple and hoe offers are gone (hoes come from the toolsmith).

### librarian

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 22 paper > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 1 | 16 feather > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 1 | 1 emerald > 11 glass | 1.00 | 0.88 | 0.88 | buy from villager |
| 2 | 7 book > 2 emerald | 2.45 | 2.00 | 0.82 | sell to villager |
| 2 | 2 emerald > 5 book | 2.00 | 1.75 | 0.88 | buy from villager |
| 3 | 14 glass > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 3 | 5 emerald > 2 lantern | 5.00 | 4.40 | 0.88 | buy from villager |
| 4 | 1 emerald > 18 paper | 1.00 | 0.90 | 0.90 | buy from villager |
| 4 | 1 lantern > 2 emerald | 2.20 | 2.00 | 0.91 | sell to villager |
| 5 | 5 emerald > 14 book | 5.00 | 4.90 | 0.98 | buy from villager |

### cleric

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 22 rotten_flesh > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 1 | 14 bone > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 1 | 5 emerald > 2 lantern | 5.00 | 4.40 | 0.88 | buy from villager |
| 2 | 1 gold_ingot > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 2 | 6 gunpowder > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 3 | 3 emerald > 2 gold_ingot | 3.00 | 2.40 | 0.80 | buy from villager |
| 3 | 2 lantern > 4 emerald | 4.40 | 4.00 | 0.91 | sell to villager |
| 4 | 4 emerald > 1 diamond | 4.00 | 3.50 | 0.88 | buy from villager |
| 4 | 1 diamond > 3 emerald | 3.50 | 3.00 | 0.86 | sell to villager |
| 5 | 7 emerald > 1 bell | 7.00 | 6.00 | 0.86 | buy from villager |

### armorer

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 9 coal > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 1 | 1 emerald > 2 iron_ingot | 1.00 | 1.00 | 1.00 | buy from villager |
| 1 | 5 iron_ingot > 2 emerald | 2.50 | 2.00 | 0.80 | sell to villager |
| 2 | 5 emerald > 2 lantern | 5.00 | 4.40 | 0.88 | buy from villager |
| 2 | 1 lantern > 2 emerald | 2.20 | 2.00 | 0.91 | sell to villager |
| 3 | 1 diamond > 3 emerald | 3.50 | 3.00 | 0.86 | sell to villager |
| 3 | 4 emerald > 1 diamond | 4.00 | 3.50 | 0.88 | buy from villager |
| 4 | 1 gold_ingot > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 4 | 3 emerald > 2 gold_ingot | 3.00 | 2.40 | 0.80 | buy from villager |
| 5 | 8 emerald > 3 lantern | 8.00 | 6.60 | 0.83 | buy from villager |
| 5 | 4 emerald > 8 iron_ingot | 4.00 | 4.00 | 1.00 | buy from villager |

### weaponsmith

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 9 coal > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 1 | 1 emerald > 1 iron_sword | 1.00 | 1.07 | 1.07 | buy from villager |
| 1 | 5 iron_ingot > 2 emerald | 2.50 | 2.00 | 0.80 | sell to villager |
| 2 | 2 emerald > 1 iron_axe | 2.00 | 1.58 | 0.79 | buy from villager |
| 2 | 1 gold_ingot > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 3 | 1 diamond > 3 emerald | 3.50 | 3.00 | 0.86 | sell to villager |
| 3 | 4 emerald > 1 diamond | 4.00 | 3.50 | 0.88 | buy from villager |
| 4 | 7 emerald > 1 diamond_sword | 7.00 | 7.05 | 1.01 | buy from villager |
| 5 | 10 emerald > 1 diamond_axe | 10.00 | 10.60 | 1.06 | buy from villager |
| 5 | 6 emerald + 1 iron_sword > 1 diamond_sword | 7.07 | 7.05 | 1.00 | buy from villager |
| 5 | 1 diamond_sword > 6 emerald | 7.05 | 6.00 | 0.85 | sell to villager |

### toolsmith

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 9 coal > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 1 | 40 cobblestone > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 1 | 1 emerald > 1 iron_hoe | 1.00 | 1.07 | 1.07 | buy from villager |
| 2 | 2 emerald > 1 iron_pickaxe | 2.00 | 1.58 | 0.79 | buy from villager |
| 2 | 5 iron_ingot > 2 emerald | 2.50 | 2.00 | 0.80 | sell to villager |
| 3 | 2 emerald > 1 iron_axe | 2.00 | 1.58 | 0.79 | buy from villager |
| 3 | 1 diamond > 3 emerald | 3.50 | 3.00 | 0.86 | sell to villager |
| 3 | 4 emerald > 1 diamond_shovel | 4.00 | 3.57 | 0.89 | buy from villager |
| 4 | 7 emerald > 1 diamond_hoe | 7.00 | 7.07 | 1.01 | buy from villager |
| 5 | 11 emerald > 1 diamond_pickaxe | 11.00 | 10.60 | 0.96 | buy from villager |
| 5 | 10 emerald > 1 diamond_axe | 10.00 | 10.60 | 1.06 | buy from villager |
| 5 | 9 emerald + 1 iron_pickaxe > 1 diamond_pickaxe | 10.58 | 10.60 | 1.00 | buy from villager |

### butcher

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 18 raw_chicken > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 1 | 14 raw_porkchop > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 1 | 1 emerald > 9 cooked_chicken | 1.00 | 0.90 | 0.90 | buy from villager |
| 2 | 14 raw_beef > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 2 | 9 coal > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 2 | 1 emerald > 8 cooked_porkchop | 1.00 | 0.96 | 0.96 | buy from villager |
| 3 | 16 raw_mutton > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 3 | 1 emerald > 8 steak | 1.00 | 0.96 | 0.96 | buy from villager |
| 4 | 1 emerald > 9 cooked_mutton | 1.00 | 0.90 | 0.90 | buy from villager |
| 4 | 8 leather > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 5 | 2 emerald > 18 steak | 2.00 | 2.16 | 1.08 | buy from villager |

### fisherman

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 11 string > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 1 | 9 coal > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 1 | 1 emerald > 12 raw_cod | 1.00 | 0.84 | 0.84 | buy from villager |
| 2 | 1 emerald > 9 cooked_cod | 1.00 | 0.90 | 0.90 | buy from villager |
| 2 | 56 stick > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 3 | 5 emerald > 2 lantern | 5.00 | 4.40 | 0.88 | buy from villager |
| 3 | 16 feather > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 4 | 2 emerald > 18 cooked_cod | 2.00 | 1.80 | 0.90 | buy from villager |
| 5 | 2 emerald > 24 raw_cod | 2.00 | 1.68 | 0.84 | buy from villager |

### shepherd

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 11 wool > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 1 | 1 emerald > 8 white_wool | 1.00 | 0.96 | 0.96 | buy from villager |
| 1 | 11 string > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 2 | 10 white_wool > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 2 | 1 emerald > 2 red_bed | 1.00 | 0.84 | 0.84 | buy from villager |
| 3 | 1 emerald > 9 wool | 1.00 | 0.90 | 0.90 | buy from villager |
| 3 | 16 raw_mutton > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 4 | 3 emerald > 4 hay_bale | 3.00 | 2.60 | 0.87 | buy from villager |
| 5 | 2 emerald > 16 white_wool | 2.00 | 1.92 | 0.96 | buy from villager |

### fletcher

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 54 stick > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 1 | 1 emerald > 22 arrow | 1.00 | 0.88 | 0.88 | buy from villager |
| 1 | 18 flint > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 2 | 16 feather > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 2 | 11 string > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 3 | 1 emerald > 15 flint | 1.00 | 0.90 | 0.90 | buy from villager |
| 3 | 1 emerald > 13 feather | 1.00 | 0.91 | 0.91 | buy from villager |
| 4 | 1 emerald > 9 string | 1.00 | 0.90 | 0.90 | buy from villager |
| 4 | 2 emerald > 44 arrow | 2.00 | 1.76 | 0.88 | buy from villager |
| 5 | 3 emerald > 64 arrow | 3.00 | 2.56 | 0.85 | buy from villager |

### mason

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 18 clay_ball > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 1 | 1 emerald > 6 brick | 1.00 | 0.90 | 0.90 | buy from villager |
| 1 | 40 cobblestone > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 2 | 22 stone > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 2 | 1 emerald > 6 mossy_cobblestone | 1.00 | 0.90 | 0.90 | buy from villager |
| 2 | 1 emerald > 6 terracotta | 1.00 | 0.90 | 0.90 | buy from villager |
| 2 | 3 emerald > 4 bricks | 3.00 | 2.48 | 0.83 | buy from villager |
| 3 | 14 sandstone > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 3 | 9 calcite > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 3 | 1 emerald > 11 sandstone_bricks | 1.00 | 0.99 | 0.99 | buy from villager |
| 4 | 1 emerald > 5 orange_terracotta | 1.00 | 0.90 | 0.90 | buy from villager |
| 4 | 1 emerald > 5 yellow_terracotta | 1.00 | 0.90 | 0.90 | buy from villager |
| 4 | 1 emerald > 5 red_terracotta | 1.00 | 0.90 | 0.90 | buy from villager |
| 5 | 1 emerald > 5 white_terracotta | 1.00 | 0.90 | 0.90 | buy from villager |
| 5 | 1 emerald > 5 brown_terracotta | 1.00 | 0.90 | 0.90 | buy from villager |
| 5 | 1 emerald > 8 calcite | 1.00 | 0.96 | 0.96 | buy from villager |

### leatherworker

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 8 leather > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 1 | 14 raw_beef > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 1 | 18 flint > 1 emerald | 1.08 | 1.00 | 0.93 | sell to villager |
| 2 | 1 emerald > 6 leather | 1.00 | 0.90 | 0.90 | buy from villager |
| 2 | 11 string > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 3 | 2 emerald > 5 book | 2.00 | 1.75 | 0.88 | buy from villager |
| 3 | 22 rotten_flesh > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 4 | 2 emerald > 12 leather | 2.00 | 1.80 | 0.90 | buy from villager |
| 5 | 3 emerald > 18 leather | 3.00 | 2.70 | 0.90 | buy from villager |

### cartographer

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 22 paper > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 1 | 1 emerald > 11 glass | 1.00 | 0.88 | 0.88 | buy from villager |
| 1 | 28 sugar_cane > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 1 | 5 iron_ingot > 2 emerald | 2.50 | 2.00 | 0.80 | sell to villager (compass ingredient) |
| 2 | 14 glass > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 2 | 1 emerald > 18 paper | 1.00 | 0.90 | 0.90 | buy from villager |
| 2 | 1 gold_ingot > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager (compass ingredient) |
| 3 | 5 emerald > 2 lantern | 5.00 | 4.40 | 0.88 | buy from villager |
| 3 | 1 lantern > 2 emerald | 2.20 | 2.00 | 0.91 | sell to villager |
| 3 | 3 emerald > 1 compass | 3.00 | 3.20 | 1.07 | buy from villager (crafted by the cartographer, never in its starting stock) |
| 3 | 2 compass > 5 emerald | 6.40 | 5.00 | 0.78 | sell to villager |
| 4 | 2 emerald > 22 glass | 2.00 | 1.76 | 0.88 | buy from villager |
| 4 | 2 emerald > 36 paper | 2.00 | 1.80 | 0.90 | buy from villager |
| 4 | 4 emerald > 1 blank_map_1 | 4.00 | 3.60 | 0.90 | buy from villager (crafted: 8 paper + compass; never in its starting stock) |
| 4 | 8 emerald > 1 blank_map_2 | 8.00 | 7.20 | 0.90 | buy from villager (crafted: 8 paper around a size 1 map, so usually out of stock) |
| 5 | 16 emerald > 1 blank_map_3 | 16.00 | 14.40 | 0.90 | buy from villager (same) |
| 5 | 32 emerald > 1 blank_map_4 | 32.00 | 28.80 | 0.90 | buy from villager (same) |
| 5 | 64 emerald > 1 blank_map_5 | 64.00 | 57.60 | 0.90 | buy from villager (same) |
| 5 | 7 emerald > 3 lantern | 7.00 | 6.60 | 0.94 | buy from villager |

Value table additions: compass 3.2 (4 iron ingots 2.0 + gold ingot 1.2), blank_map_1 3.6 (compass + 8 paper 0.4). Compasses and maps are crafted
by the cartographer at its table (js/cartography.js), so they are not restocked (`PRODUCE` is unchanged) and not in the starting stock; "Out of stock"
until it has made one. The cartographer's buy-side ingredients (paper, iron, gold) are also what it shops for from other villagers: the armorer's
`1 emerald > 2 iron_ingot` / `3 emerald > 2 gold_ingot` and the librarian's `1 emerald > 18 paper` at the usual price and stock rules.

### nitwit

No trades (holds a few junk items and 1-6 emeralds).

Totals: 142 offers; mean rho 0.89 on sells to villagers (65), 0.91 on purchases (77).

### unemployed

No offers (empty table, like nitwit). A villager is unemployed while it has no jobsite block (js/jobs.js); its stock is the nitwit junk + 1-6 emeralds. Its
first job adds that profession's starting wares to its inventory (no emeralds, once per villager, so breaking and replacing a block cannot farm stock);
later profession changes keep the inventory as it is and offers come from the new table + whatever is in stock. Villagers that have traded (xp > 0)
never change profession.

### explorer

No fixed offers (`TRADES.explorer` is empty, `PRODUCE.explorer` empty); starting stock is a tent and 6-24 emeralds (no maps). Its wares are the filled maps it carries (js/explorer.js `syncOffers`), one offer per finished map, priced well above the blank map and growing faster with size:

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 7 emerald > 1 filled_map (size 1) | 7 | 3.6 + exploring | 0.51 on the blank alone | buy from villager |
| 1 | 16 emerald > 1 filled_map (size 2) | 16 | 7.2 + exploring | 0.45 | buy from villager |
| 1 | 36 emerald > 1 filled_map (size 3) | 36 | 14.4 + exploring | 0.40 | buy from villager |
| 1 | 80 emerald > 1 filled_map (size 4) | 80 | 28.8 + exploring | 0.36 | buy from villager |
| 1 | 176 emerald > 1 filled_map (size 5) | 176 | 57.6 + exploring | 0.33 | buy from villager |

Only while it holds a finished map; a map it gave up on before 97% explored is priced by its coverage (at least 15%). The fill radius shrinks with map size (js/maps.js), so sizes 3-5 are rarely finished: the explorer buys small sizes far more often (weights 16:8:4:2:1) and settles for a partial map after 1500 s of exploring. The explorer buys the blank map from a cartographer at the cartographer's prices (4, 8, 16, 32, 64 for sizes 1-5, below), so a sale
leaves it 3, 8, 20, 48 and 112 emeralds ahead. Its purse is `EXPLORER_EM_CAP` 100 with +6 a day (the usual 12 / +2 could never pay for a size 3 map). The map offers are not in the old-trade tables below.

### forester

One offer, from the villager-planter mod: the player sells 1 oak sapling and gets 1 emerald (`1 oak_sapling > 1 emerald`). This is **not** inside the usual 75-92% band: a sapling is worth about 0.1 emerald by effort (`VALUE`-style), so the offer pays about 10x. It stays as in the mod; the villager's purse is the limit (6-24 emeralds at the start, +2 a day up to 12, and the offer reads "Out of emeralds" when it is empty), so the most a player can pull out in a day is a couple of emeralds. If this proves too generous, make it `8 oak_sapling > 1 emerald`. Wares: planks (level 1, `1 emerald > 30 planks`, every species) and logs (level 2, `1 emerald > 8 logs`), 104-111% of `VALUE`. `PRODUCE.forester` is empty and they are kept out of its starting pack: it sells only what it harvested (it saws up to 8 logs a day into planks, js/forester.js `saw`). The sticks and apples it picks up stay its own.
### furniture_maker

New profession (see CONTRACT.md "Furniture makers"). It buys wool and boards and sells the beds it makes from them (3 wool + 3 planks, `VALUE.red_bed` 0.42). Nothing is restocked (`PRODUCE.furniture_maker = []`): beds come only from its own crafting, wool and boards from the player or from other villagers' tables (the shepherd's `1 emerald > 8 white_wool`, the forester's `1 emerald > 30 planks`).

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 10 white_wool > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 1 | 40 planks > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 1 | 1 emerald > 2 red_bed | 1.00 | 0.84 | 0.84 | buy from villager |
| 2 | 10 oak_log > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 3 | 40 spruce_planks > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 3 | 40 birch_planks > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 3 | 10 spruce_log > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 3 | 10 birch_log > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 4 | 3 emerald > 7 red_bed | 3.00 | 2.94 | 0.98 | buy from villager |
| 5 | 40 dark_oak_planks > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 5 | 40 acacia_planks > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 5 | 10 dark_oak_log > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |

- **No round trip.** What it pays per unit stays below what any villager charges: white wool 0.100 < 0.125 (shepherd), planks 0.025 < 0.033 (forester), logs 0.10 < 0.125 (forester). The builder buys beds from the player at 0.33 each, below the furniture maker's cheapest 0.43.
- **Its own margin.** Buying everything from villagers, one bed costs 3 white wool (0.375) + 3 planks (0.1) = 0.475 emerald and sells for 0.5 (0.43 at level 4): it lives mostly on cheaper wool and boards sold by the player and on its +2 emeralds a day.

### builder

New profession (see CONTRACT.md "Builder villagers"). The builder is the one villager that mostly *buys* from the player: it needs building materials, keeps them in its inventory and places them block by block. Every offer is "sell to villager" (rho 0.79 to 0.91) except the two goods it
may hold at level 5. New value-table rows (effort in emeralds): any planks 0.03 (a log makes 4 planks), any log 0.12 (axe + finding a tree, 8 species), oak_door 0.07 (6 planks make 3), torch 0.04 (coal + stick make 4), oak_fence 0.05 (5 planks make 3).
Building wood is cheap on purpose: a house needs ~100 blocks of wood and stone, which at these prices is worth 3 to 4 emeralds.

| Lvl | Offer | In | Out | rho | Kind |
|---:|---|---:|---:|---:|---|
| 1 | 40 cobblestone > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 1 | 40 planks > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 1 | 10 oak_log > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 1 | 40 spruce_planks > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 1 | 10 spruce_log > 1 emerald | 1.20 | 1.00 | 0.83 | sell to villager |
| 2 | 40 birch_planks / 40 acacia_planks > 1 emerald (each) | 1.20 | 1.00 | 0.83 | sell to villager |
| 2 | 10 birch_log / 10 acacia_log > 1 emerald (each) | 1.20 | 1.00 | 0.83 | sell to villager |
| 2 | 14 glass > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 3 | 40 jungle_planks / 40 dark_oak_planks > 1 emerald (each) | 1.20 | 1.00 | 0.83 | sell to villager |
| 3 | 10 jungle_log / 10 dark_oak_log > 1 emerald (each) | 1.20 | 1.00 | 0.83 | sell to villager |
| 3 | 22 stone > 1 emerald | 1.10 | 1.00 | 0.91 | sell to villager |
| 3 | 16 oak_door > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 4 | 40 mangrove_planks / 40 cherry_planks > 1 emerald (each) | 1.20 | 1.00 | 0.83 | sell to villager |
| 4 | 10 mangrove_log / 10 cherry_log > 1 emerald (each) | 1.20 | 1.00 | 0.83 | sell to villager |
| 4 | 4 bricks > 2 emerald | 2.48 | 2.00 | 0.81 | sell to villager |
| 4 | 3 red_bed > 1 emerald | 1.26 | 1.00 | 0.79 | sell to villager |
| 5 | 14 sandstone > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 5 | 14 sandstone_bricks > 1 emerald | 1.26 | 1.00 | 0.79 | sell to villager |
| 5 | 7 orange_terracotta > 1 emerald | 1.26 | 1.00 | 0.79 | sell to villager |
| 5 | 28 torch > 1 emerald | 1.12 | 1.00 | 0.89 | sell to villager |
| 5 | 1 emerald > 14 oak_door | 1.00 | 0.98 | 0.98 | buy from villager |
| 5 | 1 emerald > 24 torch | 1.00 | 0.96 | 0.96 | buy from villager |

- **No round trip.** Unit price the builder pays vs the cheapest unit price any villager charges: glass 0.071 < 0.091 (librarian, cartographer), bricks 0.50 < 0.75 (mason), red_bed 0.33 < 0.50 (shepherd), sandstone_bricks 0.071 < 0.091 (mason),
  orange_terracotta 0.143 < 0.20 (mason). Its own two sale offers are dearer than what it pays for the same item: door 0.071 > 0.0625, torch 0.042 > 0.036. Nobody else trades planks, logs, cobblestone, stone, doors or torches.
- **Budget.** Starts with 40 to 80 emeralds and earns +4 per day up to 80 (`BUILDER_EM_CAP`, `BUILDER_EM_DAY`; other villagers: +2 up to 12). The builder spends emeralds when it buys missing materials from other villagers (their normal offers: glass from the
  librarian/cartographer, beds from the shepherd, bricks/sandstone_bricks/terracotta from the mason, lanterns, ...) with the usual stock and room rules, so those trades stay inside the margins above. No daily production (`PRODUCE.builder = []`):
  the builder only has what it was given, bought or was sold. Its sale offers are normally "Out of stock" (the starting stock holds 2 doors and 3 torches); they only appear usable after the player has sold it that many.
- **Starting stock** (`BF.builder.startStock`): the small house requirement of the village style + 10 % + 8 foundation blocks, e.g. plains: ~27 cobblestone, 53 planks, 38 spruce planks (roof), 14 logs, 4 glass, 2 doors, 2 beds, 3 torches, 40-80 emeralds (9 of 18 slots).

## Old trades: what happened to each

Old tables: 179 offers across 13 trading professions (plus a merged "smith" list that duplicated three of them and was never assigned to a villager).

| Verdict | Count |
|---|---:|
| dead | 29 |
| unchanged | 1 |
| unfair | 122 |
| irrelevant | 10 |
| retuned | 17 |

"dead" offers never appeared in game (the parser skipped them). "unfair" offers existed but were far off the value table. Because stock and per-trade `maxUses` were replaced by real inventories, no old offer survives with its old quantities unless listed as unchanged.

### Biggest imbalances among offers that actually worked

| Profession | Old offer | rho | Problem |
|---|---|---:|---|
| fisherman L5 | 6 emerald > 1 bow | 0.07 | rho 0.07 against the value table (player overcharged) |
| leatherworker L1 | 3 emerald > 1 chest | 0.09 | rho 0.09 against the value table (player overcharged) |
| leatherworker L4 | 5 emerald > 2 chest | 0.10 | rho 0.10 against the value table (player overcharged) |
| shepherd L2 | 1 emerald > 1 white_wool | 0.12 | rho 0.12 against the value table (player overcharged) |
| leatherworker L3 | 2 emerald > 1 chest | 0.13 | rho 0.13 against the value table (player overcharged) |
| weaponsmith L3 | 8 emerald > 1 iron_sword | 0.13 | rho 0.13 against the value table (player overcharged) |
| cartographer L3 | 2 emerald > 3 sandstone_bricks | 0.14 | rho 0.14 against the value table (player overcharged) |
| mason L1 | 1 emerald > 10 bricks | 6.20 | rho 6.20 against the value table (player undercharged) |
| shepherd L5 | 2 emerald > 3 white_wool | 0.18 | rho 0.18 against the value table (player overcharged) |
| mason L4 | 1 emerald > 1 orange_terracotta | 0.18 | rho 0.18 against the value table (player overcharged) |
| mason L4 | 1 emerald > 1 yellow_terracotta | 0.18 | rho 0.18 against the value table (player overcharged) |
| mason L4 | 1 emerald > 1 red_terracotta | 0.18 | rho 0.18 against the value table (player overcharged) |

### dead (29)

| Profession | Lvl | Old offer | Reason |
|---|---:|---|---|
| librarian | 1 | 9 emerald > 1 bookshelf | item(s) not in game: bookshelf (silently dropped by the old parser) |
| librarian | 4 | 5 emerald > 1 compass | item(s) not in game: compass (silently dropped by the old parser) |
| librarian | 4 | 5 emerald > 1 clock | item(s) not in game: clock (silently dropped by the old parser) |
| librarian | 5 | 20 emerald > 1 name_tag | item(s) not in game: name_tag (silently dropped by the old parser) |
| cleric | 1 | 1 emerald > 2 redstone | item(s) not in game: redstone (silently dropped by the old parser) |
| cleric | 2 | 1 emerald > 1 lapis_lazuli | item(s) not in game: lapis_lazuli (silently dropped by the old parser) |
| cleric | 3 | 1 emerald > 4 glowstone | item(s) not in game: glowstone (silently dropped by the old parser) |
| cleric | 4 | 5 emerald > 1 ender_pearl | item(s) not in game: ender_pearl (silently dropped by the old parser) |
| cleric | 5 | 3 emerald > 1 experience_bottle | item(s) not in game: experience_bottle (silently dropped by the old parser) |
| armorer | 1 | 5 emerald > 1 iron_helmet | item(s) not in game: iron_helmet (silently dropped by the old parser) |
| armorer | 1 | 9 emerald > 1 iron_chestplate | item(s) not in game: iron_chestplate (silently dropped by the old parser) |
| armorer | 2 | 7 emerald > 1 iron_leggings | item(s) not in game: iron_leggings (silently dropped by the old parser) |
| armorer | 3 | 5 emerald > 1 shield | item(s) not in game: shield (silently dropped by the old parser) |
| armorer | 4 | 13 emerald + 1 diamond > 1 diamond_chestplate | item(s) not in game: diamond_chestplate (silently dropped by the old parser) |
| armorer | 5 | 16 emerald > 1 diamond_helmet | item(s) not in game: diamond_helmet (silently dropped by the old parser) |
| butcher | 5 | 10 sweet_berries > 1 emerald | item(s) not in game: sweet_berries (silently dropped by the old parser) |
| fisherman | 2 | 2 emerald > 1 fishing_rod | item(s) not in game: fishing_rod (silently dropped by the old parser) |
| fisherman | 3 | 13 raw_salmon > 1 emerald | item(s) not in game: raw_salmon (silently dropped by the old parser) |
| shepherd | 1 | 2 emerald > 1 shears | item(s) not in game: shears (silently dropped by the old parser) |
| shepherd | 3 | 3 emerald > 1 bed | item(s) not in game: bed (silently dropped by the old parser) |
| shepherd | 4 | 2 emerald > 1 painting | item(s) not in game: painting (silently dropped by the old parser) |
| fletcher | 5 | 1 emerald + 5 arrow > 5 tipped_arrow | item(s) not in game: tipped_arrow (silently dropped by the old parser) |
| leatherworker | 1 | 7 emerald > 1 leather_tunic | item(s) not in game: leather_tunic (silently dropped by the old parser) |
| leatherworker | 3 | 4 emerald > 1 leather_horse_armor | item(s) not in game: leather_horse_armor (silently dropped by the old parser) |
| leatherworker | 4 | 6 emerald > 1 saddle | item(s) not in game: saddle (silently dropped by the old parser) |
| leatherworker | 5 | 6 emerald > 1 saddle | item(s) not in game: saddle (silently dropped by the old parser) |
| cartographer | 1 | 7 emerald > 1 map | now in the game as `4 emerald > 1 blank_map_1` (level 4); a filled map is made by using it |
| cartographer | 3 | 1 compass > 1 emerald | now in the game as `2 compass > 5 emerald` (level 3) |
| cartographer | 4 | 7 emerald > 1 item_frame | item(s) not in game: item_frame (silently dropped by the old parser) |

### unfair (122)

| Profession | Lvl | Old offer | Reason |
|---|---:|---|---|
| farmer | 1 | 20 wheat_item > 1 emerald | rho 0.71 against the value table (player underpaid) |
| farmer | 1 | 26 potato > 1 emerald | rho 0.64 against the value table (player underpaid) |
| farmer | 1 | 1 emerald > 6 bread | rho 1.44 against the value table (player undercharged) |
| farmer | 2 | 6 pumpkin > 1 emerald | rho 1.19 against the value table (player overpaid) |
| farmer | 2 | 1 emerald > 4 apple | rho 0.60 against the value table (player overcharged) |
| farmer | 2 | 1 emerald > 12 wheat_seeds | rho 0.30 against the value table (player overcharged) |
| farmer | 2 | 32 wheat_seeds > 1 emerald | rho 1.25 against the value table (player overpaid) |
| farmer | 3 | 1 emerald > 8 beetroot_seeds | rho 0.24 against the value table (player overcharged) |
| farmer | 3 | 1 emerald > 4 carrot | rho 0.24 against the value table (player overcharged) |
| farmer | 3 | 2 emerald > 1 hay_bale | rho 0.33 against the value table (player overcharged) |
| farmer | 3 | 24 beetroot_seeds > 1 emerald | rho 1.39 against the value table (player overpaid) |
| farmer | 4 | 1 emerald > 6 baked_potato | rho 0.54 against the value table (player overcharged) |
| farmer | 4 | 3 emerald > 1 iron_hoe | rho 0.36 against the value table (player overcharged) |
| farmer | 4 | 12 sugar_cane > 1 emerald | rho 2.08 against the value table (player overpaid) |
| farmer | 5 | 2 emerald > 12 bread | rho 1.44 against the value table (player undercharged) |
| farmer | 5 | 1 emerald > 3 pumpkin | rho 0.42 against the value table (player overcharged) |
| librarian | 1 | 24 sugar_cane > 1 emerald | rho 1.04 against the value table (player overpaid) |
| librarian | 1 | 1 emerald > 4 glass | rho 0.32 against the value table (player overcharged) |
| librarian | 2 | 4 book > 1 emerald | rho 0.71 against the value table (player underpaid) |
| librarian | 2 | 1 emerald > 1 lantern | rho 2.20 against the value table (player undercharged) |
| librarian | 3 | 1 emerald > 6 glass | rho 0.48 against the value table (player overcharged) |
| librarian | 3 | 1 emerald > 4 calcite | rho 0.48 against the value table (player overcharged) |
| librarian | 4 | 2 emerald > 3 lantern | rho 3.30 against the value table (player undercharged) |
| librarian | 5 | 10 emerald > 1 bell | rho 0.60 against the value table (player overcharged) |
| cleric | 1 | 32 rotten_flesh > 1 emerald | rho 0.63 against the value table (player underpaid) |
| cleric | 1 | 1 emerald > 4 bone | rho 0.32 against the value table (player overcharged) |
| cleric | 2 | 3 gold_ingot > 1 emerald | rho 0.28 against the value table (player underpaid) |
| cleric | 2 | 1 emerald > 1 lantern | rho 2.20 against the value table (player undercharged) |
| cleric | 3 | 12 gunpowder > 1 emerald | rho 0.42 against the value table (player underpaid) |
| cleric | 3 | 4 emerald > 1 gold_ingot | rho 0.30 against the value table (player overcharged) |
| cleric | 4 | 6 emerald > 1 diamond | rho 0.58 against the value table (player overcharged) |
| cleric | 5 | 2 emerald > 4 gunpowder | rho 0.40 against the value table (player overcharged) |
| armorer | 1 | 15 coal > 1 emerald | rho 0.56 against the value table (player underpaid) |
| armorer | 1 | 3 emerald > 2 iron_ingot | rho 0.33 against the value table (player overcharged) |
| armorer | 2 | 4 iron_ingot > 1 emerald | rho 0.50 against the value table (player underpaid) |
| armorer | 2 | 12 emerald > 1 bell | rho 0.50 against the value table (player overcharged) |
| armorer | 3 | 1 diamond > 2 emerald | rho 0.57 against the value table (player underpaid) |
| armorer | 3 | 2 emerald > 2 lantern | rho 2.20 against the value table (player undercharged) |
| weaponsmith | 1 | 15 coal > 1 emerald | rho 0.56 against the value table (player underpaid) |
| weaponsmith | 1 | 3 emerald > 1 iron_axe | rho 0.53 against the value table (player overcharged) |
| weaponsmith | 2 | 4 iron_ingot > 1 emerald | rho 0.50 against the value table (player underpaid) |
| weaponsmith | 2 | 12 emerald > 1 bell | rho 0.50 against the value table (player overcharged) |
| weaponsmith | 3 | 24 flint > 1 emerald | rho 0.69 against the value table (player underpaid) |
| weaponsmith | 3 | 8 emerald > 1 iron_sword | rho 0.13 against the value table (player overcharged) |
| weaponsmith | 3 | 12 bone > 1 emerald | rho 1.04 against the value table (player overpaid) |
| weaponsmith | 4 | 1 diamond > 1 emerald | rho 0.29 against the value table (player underpaid) |
| weaponsmith | 5 | 15 emerald > 1 diamond_sword | rho 0.47 against the value table (player overcharged) |
| weaponsmith | 5 | 10 emerald + 1 iron_sword > 1 diamond_sword | rho 0.64 against the value table (player overcharged) |
| toolsmith | 1 | 15 coal > 1 emerald | rho 0.56 against the value table (player underpaid) |
| toolsmith | 2 | 4 iron_ingot > 1 emerald | rho 0.50 against the value table (player underpaid) |
| toolsmith | 2 | 12 emerald > 1 bell | rho 0.50 against the value table (player overcharged) |
| toolsmith | 3 | 30 flint > 1 emerald | rho 0.56 against the value table (player underpaid) |
| toolsmith | 3 | 2 emerald > 1 iron_shovel | rho 0.28 against the value table (player overcharged) |
| toolsmith | 3 | 3 emerald > 1 iron_axe | rho 0.53 against the value table (player overcharged) |
| toolsmith | 4 | 1 diamond > 1 emerald | rho 0.29 against the value table (player underpaid) |
| toolsmith | 4 | 5 emerald > 1 iron_pickaxe | rho 0.32 against the value table (player overcharged) |
| toolsmith | 4 | 8 emerald > 1 diamond_shovel | rho 0.45 against the value table (player overcharged) |
| toolsmith | 4 | 4 emerald > 1 diamond_hoe | rho 1.77 against the value table (player undercharged) |
| butcher | 1 | 14 raw_chicken > 1 emerald | rho 1.19 against the value table (player overpaid) |
| butcher | 1 | 7 raw_porkchop > 1 emerald | rho 1.79 against the value table (player overpaid) |
| butcher | 1 | 1 emerald > 5 cooked_chicken | rho 0.50 against the value table (player overcharged) |
| butcher | 2 | 15 coal > 1 emerald | rho 0.56 against the value table (player underpaid) |
| butcher | 2 | 1 emerald > 5 cooked_porkchop | rho 0.60 against the value table (player overcharged) |
| butcher | 3 | 7 raw_mutton > 1 emerald | rho 2.04 against the value table (player overpaid) |
| butcher | 3 | 10 raw_beef > 1 emerald | rho 1.25 against the value table (player overpaid) |
| butcher | 4 | 1 emerald > 4 steak | rho 0.48 against the value table (player overcharged) |
| butcher | 4 | 1 emerald > 4 cooked_mutton | rho 0.40 against the value table (player overcharged) |
| butcher | 5 | 2 emerald > 8 steak | rho 0.48 against the value table (player overcharged) |
| fisherman | 1 | 20 string > 1 emerald | rho 0.50 against the value table (player underpaid) |
| fisherman | 1 | 1 emerald + 6 raw_cod > 6 cooked_cod | rho 0.42 against the value table (player overcharged) |
| fisherman | 2 | 1 emerald + 6 raw_chicken > 6 cooked_chicken | rho 0.44 against the value table (player overcharged) |
| fisherman | 3 | 1 emerald > 8 sand | rho 0.24 against the value table (player overcharged) |
| fisherman | 3 | 12 bone > 1 emerald | rho 1.04 against the value table (player overpaid) |
| fisherman | 4 | 6 apple > 1 emerald | rho 1.11 against the value table (player overpaid) |
| fisherman | 5 | 6 emerald > 1 bow | rho 0.07 against the value table (player overcharged) |
| shepherd | 1 | 18 white_wool > 1 emerald | rho 0.46 against the value table (player underpaid) |
| shepherd | 1 | 18 wool > 1 emerald | rho 0.56 against the value table (player underpaid) |
| shepherd | 2 | 1 emerald > 1 white_wool | rho 0.12 against the value table (player overcharged) |
| shepherd | 2 | 16 string > 1 emerald | rho 0.63 against the value table (player underpaid) |
| shepherd | 3 | 1 emerald > 2 wool | rho 0.20 against the value table (player overcharged) |
| shepherd | 4 | 1 emerald > 1 hay_bale | rho 0.65 against the value table (player overcharged) |
| shepherd | 5 | 2 emerald > 3 white_wool | rho 0.18 against the value table (player overcharged) |
| shepherd | 5 | 3 emerald > 2 hay_bale | rho 0.43 against the value table (player overcharged) |
| fletcher | 1 | 32 stick > 1 emerald | rho 1.56 against the value table (player overpaid) |
| fletcher | 1 | 1 emerald > 16 arrow | rho 0.64 against the value table (player overcharged) |
| fletcher | 1 | 1 emerald + 10 gravel > 10 flint | rho 0.46 against the value table (player overcharged) |
| fletcher | 2 | 26 flint > 1 emerald | rho 0.64 against the value table (player underpaid) |
| fletcher | 2 | 2 emerald > 1 bow | rho 0.21 against the value table (player overcharged) |
| fletcher | 2 | 12 feather > 1 emerald | rho 1.19 against the value table (player overpaid) |
| fletcher | 3 | 14 string > 1 emerald | rho 0.71 against the value table (player underpaid) |
| fletcher | 3 | 2 emerald > 24 arrow | rho 0.48 against the value table (player overcharged) |
| fletcher | 4 | 24 feather > 1 emerald | rho 0.60 against the value table (player underpaid) |
| fletcher | 4 | 1 emerald > 4 string | rho 0.40 against the value table (player overcharged) |
| fletcher | 5 | 4 emerald > 64 arrow | rho 0.64 against the value table (player overcharged) |
| mason | 1 | 1 emerald > 10 bricks | rho 6.20 against the value table (player undercharged) |
| mason | 2 | 1 emerald > 4 mossy_cobblestone | rho 0.60 against the value table (player overcharged) |
| mason | 2 | 1 emerald > 2 terracotta | rho 0.30 against the value table (player overcharged) |
| mason | 3 | 16 calcite > 1 emerald | rho 0.52 against the value table (player underpaid) |
| mason | 3 | 1 emerald > 4 sandstone_bricks | rho 0.36 against the value table (player overcharged) |
| mason | 4 | 1 emerald > 1 orange_terracotta | rho 0.18 against the value table (player overcharged) |
| mason | 4 | 1 emerald > 1 yellow_terracotta | rho 0.18 against the value table (player overcharged) |
| mason | 4 | 1 emerald > 1 red_terracotta | rho 0.18 against the value table (player overcharged) |
| mason | 5 | 1 emerald > 1 white_terracotta | rho 0.18 against the value table (player overcharged) |
| mason | 5 | 1 emerald > 1 brown_terracotta | rho 0.18 against the value table (player overcharged) |
| mason | 5 | 1 emerald > 4 calcite | rho 0.48 against the value table (player overcharged) |
| leatherworker | 1 | 6 leather > 1 emerald | rho 1.11 against the value table (player overpaid) |
| leatherworker | 1 | 3 emerald > 1 chest | rho 0.09 against the value table (player overcharged) |
| leatherworker | 2 | 26 flint > 1 emerald | rho 0.64 against the value table (player underpaid) |
| leatherworker | 2 | 1 emerald > 2 white_wool | rho 0.24 against the value table (player overcharged) |
| leatherworker | 3 | 2 emerald > 1 chest | rho 0.13 against the value table (player overcharged) |
| leatherworker | 3 | 9 rotten_flesh > 1 emerald | rho 2.22 against the value table (player overpaid) |
| leatherworker | 4 | 5 emerald > 2 chest | rho 0.10 against the value table (player overcharged) |
| leatherworker | 5 | 4 emerald > 3 lantern | rho 1.65 against the value table (player undercharged) |
| cartographer | 1 | 11 glass > 1 emerald | rho 1.14 against the value table (player overpaid) |
| cartographer | 1 | 24 sugar_cane > 1 emerald | rho 1.04 against the value table (player overpaid) |
| cartographer | 2 | 11 glass > 1 emerald | rho 1.14 against the value table (player overpaid) |
| cartographer | 2 | 1 emerald > 4 white_wool | rho 0.48 against the value table (player overcharged) |
| cartographer | 3 | 2 emerald > 3 sandstone_bricks | rho 0.14 against the value table (player overcharged) |
| cartographer | 3 | 1 emerald > 6 glass | rho 0.48 against the value table (player overcharged) |
| cartographer | 4 | 1 emerald > 2 white_terracotta | rho 0.36 against the value table (player overcharged) |
| cartographer | 5 | 10 emerald > 1 bell | rho 0.60 against the value table (player overcharged) |
| cartographer | 5 | 3 emerald > 2 lantern | rho 1.47 against the value table (player undercharged) |

### irrelevant (10)

| Profession | Lvl | Old offer | Reason |
|---|---:|---|---|
| librarian | 3 | 12 string > 1 emerald | not part of this profession's scope here: string |
| armorer | 5 | 4 emerald + 4 iron_ingot > 1 bell | not part of this profession's scope here: bell |
| weaponsmith | 1 | 2 emerald > 1 stone_sword | not part of this profession's scope here: stone_sword |
| toolsmith | 1 | 1 emerald > 1 stone_axe | not part of this profession's scope here: stone_axe |
| toolsmith | 1 | 1 emerald > 1 stone_shovel | not part of this profession's scope here: stone_shovel |
| toolsmith | 1 | 1 emerald > 1 stone_pickaxe | not part of this profession's scope here: stone_pickaxe |
| toolsmith | 1 | 1 emerald > 1 stone_hoe | not part of this profession's scope here: stone_hoe |
| fisherman | 4 | 1 emerald > 4 ice | not part of this profession's scope here: ice |
| fisherman | 5 | 1 emerald > 4 packed_ice | not part of this profession's scope here: packed_ice |
| mason | 1 | 10 clay > 1 emerald | not part of this profession's scope here: clay |

### retuned (17)

| Profession | Lvl | Old offer | Reason |
|---|---:|---|---|
| farmer | 1 | 22 carrot > 1 emerald | quantities re-balanced (old rho 0.76) |
| farmer | 1 | 15 beetroot > 1 emerald | quantities re-balanced (old rho 0.95) |
| farmer | 5 | 8 emerald > 1 diamond_hoe | quantities re-balanced (old rho 0.88) |
| librarian | 1 | 24 paper > 1 emerald | quantities re-balanced (old rho 0.83) |
| cleric | 4 | 16 bone > 1 emerald | quantities re-balanced (old rho 0.78) |
| armorer | 4 | 8 emerald > 2 diamond | quantities re-balanced (old rho 0.88) |
| weaponsmith | 4 | 12 emerald > 1 diamond_axe | quantities re-balanced (old rho 0.88) |
| toolsmith | 5 | 13 emerald > 1 diamond_pickaxe | quantities re-balanced (old rho 0.82) |
| toolsmith | 5 | 12 emerald > 1 diamond_axe | quantities re-balanced (old rho 0.88) |
| butcher | 2 | 1 emerald > 8 cooked_chicken | quantities re-balanced (old rho 0.80) |
| fisherman | 1 | 10 coal > 1 emerald | quantities re-balanced (old rho 0.83) |
| fisherman | 2 | 15 raw_cod > 1 emerald | quantities re-balanced (old rho 0.95) |
| mason | 2 | 20 stone > 1 emerald | quantities re-balanced (old rho 1.00) |
| mason | 3 | 16 sandstone > 1 emerald | quantities re-balanced (old rho 0.78) |
| leatherworker | 1 | 16 raw_beef > 1 emerald | quantities re-balanced (old rho 0.78) |
| leatherworker | 2 | 12 string > 1 emerald | quantities re-balanced (old rho 0.83) |
| cartographer | 1 | 24 paper > 1 emerald | quantities re-balanced (old rho 0.83) |

### unchanged (1)

| Profession | Lvl | Old offer | Reason |
|---|---:|---|---|
| librarian | 2 | 16 feather > 1 emerald | kept as is |

