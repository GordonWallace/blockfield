# Village mayors (experimental)

A Claude-run mayor who looks after a village over many days and steers its builders. Branch `exp-llm-villager`, not targeted at a release.
This is the reference for how a mayor works. Keep it in step with the code when either changes.

| What | Where |
| --- | --- |
| The mayor in the game: wakes, briefing, tools, records, walking to builders | `js/mayor.js` |
| Builders taking orders, and the buildability check | `js/builder.js` ("a mayor's orders": `assess`, `direct`) |
| The server side: `/claude/mayor`, tool definitions, spend cap, prompt caching | `debug/claude.js` |
| The system prompt | `prompts/mayor-system.md` (read for every review, so edits apply right away) |
| Test (mock API) | `test/mayor.js` |

**Prototype scope.** One mayor, for the loaded village nearest the world spawn (within 600 blocks). It exists only when the game server has an
API key, like the Sage (`docs/CLAUDE_VILLAGER.md`); `?mayor=0` or `?claude=0` turns it off. The player can't talk to it yet, and mayors don't
talk to each other. Model: Claude Haiku 5.5 for everything, effort `medium`, at most 4096 output tokens and 10 rounds per review.

## How a review works

1. Something **wakes** the mayor (below).
2. The game writes a **briefing** from the village's own numbers and the mayor's saved records.
3. The page POSTs `{ mayor: { name, village }, wake, briefing }` to `/claude/mayor`. The server sends the system prompt, the tools and one user
   message: `Why you were woken: <reason>` followed by the briefing.
4. When the model calls tools, the server hands the calls back to the page, which answers them **live** from the world as it is at that
   moment, and posts the results back. This repeats until the model stops.
5. The model's final text (two or three sentences) is kept as the review's **summary**: in the village log, the game log and the next briefing.

Nothing carries over between reviews except the records the mayor writes with its tools. There is no chat history.

**How a review ends.** Each model reply ends with a stop reason. `tool_use` means "answer these calls and let me carry on"; the game answers
and the server sends the conversation back for another round. When the model replies with plain text instead (stop reason `end_turn`),
the review is over and that text is its summary. The model decides this itself: it stops once it has done what it wants. A **round** is
one model reply, which may hold several tool calls at once, so 10 rounds allows more than 10 tool calls. If the 10th reply still asks for
tools, those calls are not carried out and the review ends there without a summary.

## What wakes the mayor

Each wake is one review, which means one or more API calls. Defined in `WAKES` in `js/mayor.js`.

| Event | Wakes it? | When exactly |
| --- | --- | --- |
| `appointed` | Yes | The mayor was just created: its first review. |
| `morning` | Yes | Once per game day, at the first check after the day begins (before builders stop at dusk). |
| `death` | Yes | A villager of the village died (name, job and cause are in the briefing). |
| `starving` | Yes | Villagers started starving: none before, or 2 more than at the last review. |
| `blocked` | Yes | A builder came to an ordered structure and couldn't build it (materials gone, no room, land not suited). |
| `orders_done` | Yes | A builder finished everything the mayor ordered and is choosing for itself again. |
| `goal` | Yes | A goal reached its judging day and the game judged it met or missed. |
| `unreachable` | Yes | The mayor tried 5 times to walk to a builder and couldn't, or the builder is no longer a builder. |
| `built` | No | A builder finished a structure (ordered or not). |
| `born` | No | A child was born. |
| `homeless` | No | More villagers without a bed than at the last check. |
| `delivered` | No | The mayor told a builder its orders. |

Events that don't wake the mayor are listed in the next briefing under "Since your last review".

Throttles:
- One review at a time.
- An event wakes the mayor only once 0.15 game day (about 3 real minutes) has passed since the last review (`EVENT_GAP`). A morning or
  appointment wake doesn't wait for that.
- A review refused by the spend cap is put off for 2 real minutes; a failed one for 30 seconds. Its events are kept for the next try.

At normal speed (a game day is 20 real minutes) expect about 3 morning reviews an hour, plus event reviews.

## The system prompt

The text below is the current `prompts/mayor-system.md`, without its leading comment. It is the same for every mayor, with no names or numbers
in it, so the API can cache it and later mayors can share it. Everything specific to one mayor comes in the briefing.

The "What builders can build" section tells the mayor what each structure gives the village. It deliberately doesn't say when to build it.

```text
You are the mayor of a village in Blockfield, a blocky world like Minecraft. Villagers here live real lives: they eat, sleep in beds, work at jobsites, trade with each other for emeralds, have children when there is room, and die to hunger or monsters. Nothing appears from nothing: every block a builder places was bought, crafted or dug by someone.

Your job is to look after the village over many days: notice what it needs, decide what is worth building, steer the builders, and learn from how your decisions turn out. Nobody tells you what to do. You are woken now and then (each morning, and when something happens), given a briefing, and you act through your tools. Between reviews you remember only what you wrote down: your strategy, your journal, your lessons and your goals, which come back to you in every briefing.

How you act:
- You can't place blocks or trade yourself. You guide the village's builders. A builder builds one structure at a time, buying or crafting the materials from other villagers, and normally picks what to build by chance, weighted by what the village seems to lack.
- give_orders sets a builder's queue. You then walk over and tell them in person; until you have, they carry on with their own choices. A builder always finishes the structure it is on before starting yours. Orders that can't be built now are refused, so check_structure first when you are unsure. An order that later becomes impossible (materials sold out, no room) is skipped and you'll hear about it.
- set_goal records a measurable aim; the game measures it for you and shows you the result. Use goals to find out whether your plans work.
- update_strategy, write_journal and update_lessons are your memory. Write down what you decided and why, and what you expect to happen, so a later you can judge it. Keep them short and concrete.
- Not every review needs action. If things are on track, say so and stop. Builders left alone still build useful things.

What builders can build, and what each gives the village (what's worth it here is yours to judge):
- small_house: 1 bed. medium_house: 2 beds. cottage: 1 bed, larger. A villager without a bed sleeps rough. The village only grows while it has at least one free bed: two well-fed adults (7 bread's worth each) then have a child, who eats 2 bread a day until grown and then takes a free jobsite.
- veg_farm: a field and a composter. An unemployed villager becomes a farmer there and grows wheat, carrots, potatoes and beetroot, which feed the village through trade. Takes a few days to start producing.
- pen (sheep), pasture (cows), coop (chickens), sty (pigs): a paddock and its jobsite block. A keeper fetches wild animals of that kind into it, so it only works with those animals nearby, and breeds them for meat, wool, milk, eggs or leather.
- bakehouse: an oven. A baker turns wheat, sugar, eggs and milk into bread, cake and pie. Treats make villagers happier. At most one baker per 15 villagers.
- well: water for farms and buckets.
- lamp_posts: light along the paths; monsters don't appear on well-lit ground.
- market_stall: a merchant's counter. A merchant carries surplus goods to nearby villages and brings back what sells well at home. At most one merchant per 20 villagers.
- workshop: furnaces, a chest and a crafting table.
- glassworks: a glass kiln. A glassmaker makes glass and panes from sand (only where sand is near). Without panes, houses get open windows.
- apiary: a honey extractor. A beekeeper keeps bees for honey (only on grassland).
- stable: a tack rack and paddock. A stable hand tames wild horses (only with wild horses nearby; one per village).
- bridge: a crossing over a river villagers keep swimming or walking round (only where there is such a crossing).
Every structure costs materials (mostly wood, plus stone, glass, iron or hay for some) that must be bought from the village's own villagers, so a builder can only start what the village can supply. Jobsites only help if someone is free to take them: new jobs are filled by unemployed villagers and grown children.

The briefing's numbers come straight from the game and are current; trust them over your memory. Food is measured in bread's worth: a grown villager eats 1 a day, a child 2. A villager holding less than a day's food is hungry; one that hasn't eaten for a whole day is starving. "Food days" is the food the villagers hold divided by what they all eat in a day.

Reply at the end of each review with two or three plain sentences: what you saw and what you did (or why you did nothing). That summary is logged for the player to read.
```

## The briefing

Written fresh for every review by `brief()` in `js/mayor.js`. Sections, in order:

| Section | What's in it |
| --- | --- |
| Opening lines | The mayor's name, village, start day and temperament; the time and whether builders are working; the review number and the last review's summary. |
| YOUR STRATEGY | The mayor's own strategy text. |
| YOUR LESSONS | The mayor's own lessons text. |
| GOALS | Each open goal with its current value and its value when set; up to the last 5 closed goals with their results. |
| YOUR JOURNAL | The last 15 entries, plus any entries rolling off after this review (so the mayor can fold them into its lessons). |
| SINCE YOUR LAST REVIEW | The events above, timestamped. |
| THE VILLAGE NOW | Population, with its change over 7 days. Beds, free beds and villagers without a bed. Food held, eaten per day, food days, hungry, starving. Happiness score and its parts. Births, deaths and trades over the last 7 days. Jobs by profession. Jobsites nobody works. Food producers by kind. Structures the builders have finished. Wild animals near (counts that matter for paddocks and stables). The most-wanted items nobody sells, and items for sale that aren't selling. |
| BUILDERS | One line each: what it is doing now, the structure it is on (ordered or its own choice) and its progress, what it means to build next, and the mayor's orders. Those orders are either not told yet, or told with each item's state (waiting, building, or blocked with the reason) and what it has built for the mayor. |
| CAN BE BUILT NOW | Every structure type, sorted into buildable now (and whether materials must be bought first) or not, with the reason. This uses the builders' check without the search for room. |

Example: the first briefing in a test world, at the mayor's appointment.

```text
Why you were woken: you have just been appointed mayor; look the village over, write a strategy and decide what to do first; a new day has begun

You are Wren Hallet, mayor of Bluff since day 1, 08:23. Your temperament: thrifty: you dislike waste and prefer what the village can supply easily.
It is day 1, 08:24 (builders work until dusk, about 17:16). This is review 1.

YOUR STRATEGY
(none written yet)

YOUR LESSONS
(none yet)

GOALS
(none)

YOUR JOURNAL (newest last)
(empty)

SINCE YOUR LAST REVIEW
- day 1, 08:23: A new day began.

THE VILLAGE NOW
Population: 44 (44 adults, 0 children).
Beds: 44, free: 0. Without a bed: 14. (The village grows only while a bed is free.)
Food held: 906 bread's worth; eaten per day: 44 (20.6 food days). Hungry (under a day's food): 1. Starving: 0.
Happiness: 94/100: 1 unemployed (-3), 1 with no emeralds (-3).
Last 7 days: 0 births, 0 deaths, 0 trades.
Jobs: Nitwit 5, Cartographer 3, Cleric 2, Librarian 2, Weaponsmith 2, Armorer 2, Fisherman 2, Fletcher 2, Mason 2, Farmer 2, Butcher 2, Toolsmith 2, Builder 2, Shepherd 2, Merchant 2, Baker 2, Unemployed 1, Leatherworker 1, Forester 1, Pig Farmer 1, Stable Hand 1, Furniture Maker 1, Miner 1, Beekeeper 1.
Jobsites nobody works: 9 Farmer.
Food producers (farms and paddocks, built or generated): vegetable farm 11, sheep pen 2, pasture 0, chicken coop 0, sty 1.
Built by the village's builders so far: 1 small house, 1 well.
Wild animals within 80 blocks: horses 0, sheep 0, cows 2+, chickens 2+, pigs 2+ (a paddock or stable needs 2 or more of its kind).
Wanted and not for sale (last 2 days, hours waited): nothing.
Held for sale and not selling: nothing.

BUILDERS
- Aria Cooper: Hungry. Next it means to build: well. No orders from you: chooses for itself.
- Ella Manihera: Fetching: 2 Red Bed. No orders from you: chooses for itself.

CAN BE BUILT NOW (materials and land, as the builders check them; use check_structure for detail and room)
Yes: small house, medium house, cottage, vegetable farm (needs buying), pasture (needs buying), chicken coop (needs buying), sty, well, lamp posts, market stall, workshop, bakehouse (needs buying), apiary (needs buying).
No - sheep pen: fewer than 2 wild sheeps within 80 blocks to fill it
No - glassworks: no natural sand within 64 blocks
No - stable: the village already has a stable (one per village)
No - bridge: no river crossing busy enough to need a bridge
```

Day numbers and clock times match the village log (`Day 1 06:00` is the world's first sunrise), and goals use the same day numbers.

## Tools

Defined in `MAYOR_TOOLS` in `debug/claude.js`, answered by `TOOLS` in `js/mayor.js`.

| Tool | Input | What it does and returns |
| --- | --- | --- |
| `check_structure` | `type`; optional `builder` | The builders' own buildability check (see below), including a search for room. It returns the verdict, the reasons it can't be built, and for each builder what it holds or would need, with how many are for sale in the village. |
| `list_villagers` | none | Every villager: name, job, what they are doing, hungry or starving, no bed, and food on hand. |
| `market_report` | none | The last 2 game days: items wanted and not bought (by whom, hours waited), items held for sale and not selling, and the most traded items. |
| `give_orders` | `builder` (a name or `all`); `build` (up to 5 types, each with a reason); `avoid` (types); `reason` | Checks each queued type against that builder with `check_structure`'s test. It refuses those that can't be built, with the reason, and queues the rest as orders waiting to be told. An empty `build` and `avoid` releases the builder. New orders replace earlier ones. |
| `set_goal` | `text`, `metric`, `structure` (for `structures`), `op` (`>=` or `<=`), `target`, `by_day` | Records a goal the game measures. At most 5 open goals. |
| `close_goal` | `id`, `reason` | Closes an open goal early. |
| `update_strategy` | `text` (800 characters at most) | Replaces the strategy. |
| `write_journal` | `text` (300 characters at most) | Adds a dated journal entry. |
| `update_lessons` | `text` (600 characters at most) | Replaces the lessons. |

Goal metrics, all measured by the game and never judged by the model:

| Metric | What the game measures |
| --- | --- |
| `population` | Villagers |
| `free_beds` | Beds minus villagers |
| `homeless` | Villagers without a bed |
| `starving` | Villagers starving |
| `food_days` | Food held divided by food eaten per day |
| `happiness` | The village happiness score (0 to 100) |
| `unemployed` | Unemployed adults |
| `structures` | Finished structures of one type built by the builders |
| `births_week` | Births in the last 7 days |
| `deaths_week` | Deaths in the last 7 days |

## How builders take orders

- **Orders apply only once told in person.** `give_orders` only records the orders. The mayor then walks to each builder with untold orders, on
  villager routes through doors (the Sage's errand walker), and tells it once within 3 blocks. That call is `BF.builder.direct`, and it writes a
  village log line such as "Wren Hallet (Mayor) told Aria Cooper (Builder) to build well; leave lamp posts alone: water first".
- **Before that, the builder carries on as usual.** It keeps its weighted rolls, and any builder not yet told does the same.
- **The mayor waits for daylight.** It doesn't approach sleeping builders or walk over after dusk. If it fails to reach a builder, it tries
  again 20 seconds later. After 5 failures it waits 2 minutes and wakes with `unreachable`.
- **In-progress work comes first.** A builder that is told mid-structure, or while buying materials for one, finishes it. Only its next choice
  follows the orders: the next structure it had already picked is dropped.
- **The queue is taken first to last.** When the builder picks its next structure, each queued type is checked again: eligibility and
  materials, as the rolls check them.
  - A type that can't be built now is marked **blocked** with the reason and skipped, and the mayor is woken. If it becomes possible later,
    it goes back to waiting.
  - When nothing queued can be built, the builder rolls as usual, still avoiding the `avoid` types.
- **Finished items are crossed off.** A structure begun for an order carries the order's id, and its item is crossed off when it's finished.
  When the queue is empty the builder chooses for itself again (avoid list kept), and the mayor is woken with `orders_done`.
- **The mayor always knows what each builder is doing,** whether directed or not: the BUILDERS section of every briefing.
- **Orders are saved.** Told orders are saved with the builders (`orders:<village key>` next to `built:<village key>`). Orders not yet told
  are saved with the mayor.

## The buildability check

`BF.builder.assess(R, type, builder?, { site })` in `js/builder.js` reuses the builders' own rules, so a mayor can't order anything a builder
couldn't start. It is used by `check_structure`, by `give_orders` (to refuse items), by the briefing's CAN BE BUILT NOW list (without the
room search), and, in its lighter form, when a builder comes to each queued item.

Checks, in order:

1. **Land and surroundings**, the same as the rolls (`ineligible`):
   - Stable: 2 or more wild horses within 80 blocks, and none in the village yet.
   - Sheep pen, pasture, coop and sty: 2 or more wild animals of that kind within 80 blocks.
   - Glassworks: natural sand within 64 blocks.
   - Apiary: a grassland village.
   - Bridge: a river crossing busy enough.
2. **Materials**, worked out for that builder's own bag (`analyze`, crafting included: planks from logs, doors, torches and so on).
   - Every missing item must be either for sale in the village right now (another villager's offer with stock) or dirt it can dig.
   - Glass panes may be left out where nobody makes glass: windows are then left open and glazed later.
   - Without a named builder, every builder is checked, and the structure counts as buildable if any one of them can do it.
3. **Recent failure:** the builder looked for room for one a short while ago and found none (its 0.12-day cooldown).
4. **Room** (only when asked, as `check_structure` and `give_orders` do): the builder's own site search finds free, level enough ground within
   40 blocks of the village.

In practice, from the test world:
- A stable was refused because the village already had one.
- A coop was refused for want of 2 wild chickens nearby.
- A glassworks was refused with no sand near.
- A bridge was refused with no busy crossing.
- A vegetable farm counted as buildable, with materials the builders would buy from other villagers.

Each refusal's reason goes back to the model word for word.

What it can't promise:
- A seller can sell out between the order and the purchase, and land can be taken by another structure. The builder then marks the item
  blocked when it comes to it and the mayor is woken.
- Merchant and baker jobs have their own population limits (one per 20 and one per 15 villagers). A stall or bakehouse can be built past
  them, but nobody will take the job. The prompt tells the mayor about these limits.

## Records the mayor keeps

All saved with the world (`js/save.js` key `mayors`), one record per village.

| Record | Written by | Limits |
| --- | --- | --- |
| Name, temperament, village, start day | The game, at appointment (a temperament picked from 4) | Fixed |
| Strategy | `update_strategy` | 800 characters |
| Lessons | `update_lessons` | 600 characters |
| Journal | `write_journal` | 15 entries in the briefing; older ones are shown once more as rolling off, then dropped |
| Goals | `set_goal` / `close_goal`; judged by the game | 5 open; the last 30 kept |
| Orders not yet told | `give_orders` | One set per builder |
| Last review | The game: day, wake reason, summary, tools used, cost | Latest only |
| Events since the last review | The game | 40 at most |
| Total spent, review count, where it stands | The game | |

## Cost and limits

- **Spend cap:** `BF_CLAUDE_PER_HOUR_USD`, default $1. It covers every Claude call the game server makes (Sage chat, house designs and mayor
  reviews) over a rolling hour. Over the cap, a new request is refused, and a review that is under way stops before its next round.
- **Request caps:** the existing per-minute and per-day caps (`BF_CLAUDE_PER_MIN`, `BF_CLAUDE_PER_DAY`) count reviews too.
- **Prompt caching:** reviews ask for prompt caching (top-level `cache_control`), so the shared prompt and tools, and each round of a
  review, are read back at a tenth of the input price. The debug screen shows how many tokens came from the cache.
- **Cost per review:** expected to be under half a cent on Haiku. The real figure for every review is in the game log and on the debug screen.

## Benchmark: a village with a mayor against the same village without

`tools/mayorbench.js` runs the same village twice for the same number of game days, once with a mayor and once without, and compares the numbers day by day. Run it from the repo on a machine with the API key:

```
NODE_PATH=$(npm root -g) node tools/mayorbench.js --seeds 3,7,11 --days 10
```

- Options: `--seeds` (worlds, default 3,7,11), `--days` (game days per run, default 10), `--dt` (step, default 0.1 game s), `--out` (report path), `--mock` (stand-in API, no key or cost), `--headed`.
- The village is the nearest to the spawn with 6+ buildings and a builder. Math.random is seeded from the seed, and drawing is off. The world is stepped by hand, and it waits while a review is out, so the model's thinking time costs the village nothing.
- Measured at the start and every game day (`BF.mayor.metrics`): population, free beds, homeless, starving, food days, happiness, unemployed, structures built (and by type), deaths. The mayor's reviews, spend, final strategy, lessons, goals and the village log of builds and mayor lines go in the report too.
- The report is Markdown (default `tools/mayorbench-<date>.md`) with the raw numbers beside it (`.json`).
- Cost: only the mayor runs spend, about $0.05-0.15 per 10-day run on Haiku. The hourly cap applies; a refused review is retried later.
- Caveats: the two runs of a seed start close but not identical, because chunks and villagers load asynchronously, so the report shows both starts. One seed is one anecdote; use several. 10 game days is short for farms and children to pay off.
- The page hooks: `?mayorauto=0` (no automatic appointment), `?mayortick=0` (no timer; the bench calls `BF.mayor.tick()`), `BF.mayor.appoint(key)`, `BF.mayor.metrics(key)`.

## Where to watch it

- **Debug screen, API calls panel:** each review appears as "Mayor review", with the briefing, every tool call and result, the reply, tokens,
  cache reads and cost.
- **Game log, kind `mayor`:**
  - INFO: appointment, review start and end (tokens, cache reads, cost, tools, the last hour's spend), structure checks, orders given and
    delivered, goals, strategy and lessons.
  - WARN: refused or blocked orders, unreachable builders, reviews put off by the cap.
  - ERROR: failed reviews.
- **Village log, kind `mayor`:** orders told to builders, and each review's summary.
- **In-page:** `BF.mayor.state()` returns the records, `BF.mayor.brief()` the briefing as it would be sent now, `BF.mayor.wake("reason")` forces
  a review, and `BF.mayor.runTool(name, input)` runs a tool by hand.

## Not yet

- No player conversation with the mayor. The Sage's chat and house designer are kept for later.
- No mayor-to-mayor dealings.
- One mayor only. More would need a village choice rule and the spend cap shared fairly.
- The mayor doesn't act while its village is unloaded: far villages run on the village sim without it.
- Reviews are asynchronous model calls. They don't yet go through the 1.5 deterministic request queue (see the design note).
