---
title: Caves and ores
category: World generation
---
Below the surface the world is solid rock threaded with caves, studded with ore, and pocketed with other kinds of stone. The most important rule for finding ore: **ore is placed by depth below the local ground, not by absolute height.** On a mile-high world that matters, because the ground itself may be at y 1000. Dig down from wherever you stand.

## Rock layers

- **Stone** from the surface down to y 8.
- **Deepslate** below y -8. Between y 8 and y -8 the two are mixed, with deepslate becoming steadily more common as you go down.
- **Bedrock** at the very bottom, y -64. The bottom layer is solid; above it, bedrock fades out over four more layers (about 68, 51, 34 and 17 percent of blocks). You cannot dig through it.

Ground that lies near sea level has its deepslate close below; on the high plains it is about a thousand blocks down.

## Caves

There are two kinds, both carved through stone and deepslate:

- **Tunnels:** winding tubes. They are narrow near the surface and get wider with depth, reaching their full width about 160 blocks down, and wider again below y -30.
- **Caverns:** large chambers. They never come within 14 blocks of the surface or the bottom few layers, and are rarer within about 44 blocks of the surface and very near the bottom.

Caves are held back in a few places:

- Caves stop about 4 blocks under the surface, so most ground is solid on top. In roughly 90-block-wide patches ("cave entrances") they may reach the open air; trees avoid these patches.
- Near the sea or a river they stop at least 5 blocks below the lowest neighbouring ground, so water does not drain into them.
- Under a village they stop 8 blocks below the buildings, so houses never stand over a hole.

Deep cave floors (below y -15) sometimes turn to [[item:magma_block]] (3 percent of floor blocks). There is no lava in Blockfield; magma is the deep hazard.

## Ores

Each ore forms as short veins, wandering clumps that replace stone. Where a vein runs through deepslate it becomes the deepslate form of the ore (for example [[item:deepslate_iron_ore]]). "Veins per band" below means veins per 16x16-block chunk per 32 blocks of height.

| Ore | Where it begins | Where it ends | Veins per band | Largest vein (blocks) |
|---|---|---|---|---|
| [[item:coal_ore]] | Surface (even exposed cliffs, but thin) | 210 blocks down | Up to 11; peaks about 100 blocks down | 12 |
| [[item:iron_ore]] | Surface (thin) | 210 blocks down | Up to 8; peaks about 100 down | 10 |
| [[item:copper_ore]] | Surface (thin) | 210 blocks down | Up to 6.5; peaks about 100 down | 8 |
| [[item:lapis_ore]] | 24 blocks down | Bedrock | 1, rising to 3 | 7 |
| [[item:gold_ore]] | 32 blocks down | Bedrock | 3.3, rising to 10 | 7 |
| [[item:diamond_ore]] | 48 blocks down | Bedrock | 2.4, rising to 7 | 6 |
| [[item:redstone_ore]] | 48 blocks down | Bedrock | 3.5, rising to 10 | 7 |
| [[item:emerald_ore]] | 24 blocks down | Bedrock | 0.03, rising to 0.1; single blocks | 1 |

How the numbers work:

- **Coal, iron and copper** are thin near the surface, strongest about 100 blocks down, and fade out to nothing by about 200 blocks down. In rock exposed above the surface (cliff faces and mountainsides) they appear at a tenth of their peak rate. Because the rare ores continue to bedrock but these stop, the deepslate forms of coal, iron and copper exist only where the ground is low enough, no more than about 200 blocks above y -8 (the lowlands and coasts). They never occur on the high plains.
- **Gold, lapis, diamond, redstone and emerald** start at the depths shown, at about a third of their eventual strength, and get richer the deeper you go. Roughly half of the gain arrives within 200 blocks of where they begin, so below a kilometre the rate barely changes. Nothing generates in the bottom five layers above bedrock.
- **Emerald** is one block at a time, almost never seen in ordinary ground. In the mountain biomes (Windswept Hills, Snowy Slopes, Jagged Peaks, Stony Peaks) it is common instead: about one block per chunk per 32 blocks of height, anywhere from 3 to 500 blocks below the surface, with no depth ramp.
- Miners in villages dig down to a limited depth, and the rare ores start at depths they can reach; see [[villager:miner]].

A rule of thumb on the spawn plateau, where the ground is near y 1070: coal, iron and copper are best from about y 970 and gone below about y 860; gold starts near y 1040, diamond and redstone near y 1020 and keep getting richer.

## Other stone and pockets

- [[item:granite]], [[item:diorite]] and [[item:andesite]] each form huge blobs (dozens of blocks across) from 5 blocks below the surface downward, about 1.6 blobs per band.
- [[item:tuff]] blobs sit in the deep, between y -64 and y 16 (absolute height), replacing both stone and deepslate.
- [[item:dripstone_block]] blobs lie 30 to 250 blocks below the surface.
- [[item:gravel]] (from 8 blocks down), [[item:dirt]] (from 6 down) and [[item:clay]] (20 to 300 down) occur in underground pockets. Gravel pockets run through deepslate as well as stone; dirt and clay only replace stone.
- Small pockets of [[item:water]] (from 10 blocks down) and magma blocks (from y -8 down, and some from 40 blocks down) are buried in the rock.

See [[page:mining-and-tools]] for what you need to dig each of these.
