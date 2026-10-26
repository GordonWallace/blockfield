---
title: Caravans
category: Villagers
---
[[villager:merchant|Merchants]] carry goods from one village to another. A merchant buys what its village has too much of, walks to a village where it is wanted, sells it there, buys what its own village lacks with the takings, and walks home. This is how a glut in one village can feed a shortage in another. See [[page:village-economy]] for how prices show a surplus or a lack.

## Choosing a trip
A merchant works out where carrying goods pays best. Prices tell it:

- An item is in **surplus** where a villager's sell offer for it has been marked down.
- An item is **lacking** where a villager's buy offer for it has risen.
- A village is worth visiting when the dearest buy price there beats the cheapest sell price at home by at least 5 percent for some goods. The merchant takes off a little for the length of the walk and only goes if it expects to make at least half an emerald. Goods the other village already sells as cheaply from a villager with stock to spare are never worth carrying there: its buyers can get them at home. The same rule picks what the merchant brings back.

It can choose any village within 600 blocks whose prices it has seen, whether or not that village is loaded right now. A village's prices are written down when it is first loaded and again as it unloads. Setting out loads the destination. The trip must be expected to be over within 2 game days, and a merchant that has no tent must be able to get back the same day. Villages are often more than 600 blocks apart, so some merchants have nowhere to go.

A merchant sets out at most once every 2 game days, and only one trip at a time per merchant. At most 2 trips are on the road in the whole world; other merchants wait.

## The trip
1. **Buying.** In its own village it buys up to 2 stacks of the chosen goods from villagers, through their ordinary sell offers. Their reserves hold, so a villager never sells what it needs.
2. **The walk.** It walks by day, from early morning until dusk, one and a half times as fast as an ordinary villager. Routes follow waypoints, so trips between the same two villages keep to the same ground.
3. **Selling.** At the other village it sells the goods into the buy offers of the villagers who want them, at those villagers' prices.
4. **Shopping.** With the takings it buys what its home lacks, under the same rule in the other direction.
5. **Home.** It walks back and sells those goods into the buy offers at home.

Every deal is an ordinary trade on the other villager's trade screen, so nothing appears from nothing: the merchant's purse and pack are its own. Whatever it fails to sell stays in its pack and becomes spare goods you can buy from it.

A merchant caught away from home at dusk pitches its tent and sleeps in it, then goes on in the morning, as an explorer does. One that sets out without a tent only goes if it can get home the same day.

## Keeping a trip going
While a caravan is on the road, both villages and the chunks along its route stay loaded, wherever you are, so the trip never stalls and the merchant is never lost in unloaded country. They are released when the merchant gets home. A trip that gets lost on the way or runs past 3 game days is abandoned: the merchant goes home, and that pair of villages is marked "no road" for a week. When the game gets heavy, the safety valve described in [[page:village-loading]] can end a trip early, and the merchant then goes home with its cargo.

If a merchant is killed on the road, its goods drop where it fell.

## Wearing a path
Every grass or dirt block a merchant steps on between villages is counted. After 20 crossings it becomes a dirt path, so well-used routes show on the ground. The counts are saved.

## How many merchants
A newly generated village of 8 or more villagers gets one merchant for every 20 villagers, and at least one. Its workstation, the merchant's counter, stands on the plaza. Every market stall a [[villager:builder]] puts up has a counter too, so older villages gain merchants as their builders build stalls; a jobless villager takes the counter. A village never has more than one merchant per 20 villagers, but always room for one.

You can follow the traffic on the debug screen's routes view: each pair of villages that traded, trips and goods moved in the last 7 days, and whether a merchant is on the road.
