# Fortnite 2D Replay Viewer

Paste a replay code, and it downloads the replay, parses it, and plays it back on
a 2D map: every player's position over the whole match, the storm circles with
their timers, the kill feed, and a per‑player panel.

The home screen is a **Trello‑style board**: make categories (a scrim block, a
tournament, a ranked session), drop replay codes into them, drag categories and
games into the order you'll review, and click a game to watch it. The board is
saved server‑side (`data/board.json`).

![flow](https://img.shields.io/badge/node-%E2%89%A518-informational) ![net](https://img.shields.io/badge/.NET_SDK-10-informational)

## Setup

You need **Node ≥ 18** and the **.NET 10 SDK** (`dotnet --version`). The .NET SDK
is for the replay parser — see [Why .NET](#why-a-c-parser).

```bash
npm install
npm start
```

Open **http://localhost:3000**. Add a category, then paste a replay code into it
(the 32‑hex‑character session id, the same string the in‑game "watch by code"
field takes — you can paste several at once, one per line). Or use the **Open a
replay code** box in the top‑right for a one‑off.

- **The first replay is slow** (~30–60s) while `dotnet` restores packages and
  builds the parser. Every replay after that parses in a few seconds.
- Parsed replays are cached under `data/`, so re‑opening a code is instant.
- Opening a game fills in its card subtitle (playlist, length, date).
- **Clear downloads** (top of the home screen) wipes every downloaded + parsed
  replay from `data/`. The board and its games stay — each one just re‑downloads
  and re‑parses the next time you open it.
- Tournament codes (Showdown / FNCS) work most reliably — Epic keeps those on
  their servers. Old public matches may have been purged.

You can also deep‑link straight to a replay: `http://localhost:3000/#<code>`.

### The board

| | |
|---|---|
| **Category** | "+ Add category". Click its name to rename, `×` to delete |
| **Game** | "+ Add game", paste one or more codes. Click a card to watch it; hover for rename (✎) / remove (×) |
| **Reorder** | Drag a category by its header; drag a game within or between categories. Saved as you go |

## Using the viewer

| | |
|---|---|
| **Play / scrub** | Space to play/pause, drag the timeline, `←`/`→` to skip 5s, `[` `]` for speed (0.5–8×) |
| **Timeline ticks** | Purple ticks (above the bar) = a zone finished closing. Green ticks (below) = the selected player's elims (bright) and knocks (faint). Hover any tick for the detail. Bot / AI‑filler kills don't count anywhere — feed, ticks, or the panel's elim number |
| **Pan / zoom** | Drag to pan, scroll to zoom, double‑click or `Home` to reset the view |
| **Players** | Arrows pointing where they're facing, coloured by team. Hover for a name, click to select. Knocked players go orange; airborne (bus / skydive / glider) go faint. Panel shows team (with how many are up), placement, elims, a health + shield bar, and running **damage taken** / **storm damage** counters. **Follow** locks the camera; **Teammate ›** / `Tab` cycles squadmates |
| **Stats** | Toggle the **Stats** popup: how many alive players are inside the wall vs caught in the storm right now, plus alive / teams / zone timer. Updates live |
| **Storm** | White ring = the wall now, blue dashed = where it closes to next, top bar = which zone and the countdown |
| **Bus** | Yellow dashed line = the battle‑bus flight path; the bus icon flies it and vanishes once it's off the map. Inferred from where players jump (build‑42 replays don't replicate the aircraft), so it needs a normal‑sized lobby |
| **HUD** | Players alive, and teams alive in squad modes. **Names** labels everyone when zoomed in |
| **Align** | Nudge the map (drag / scroll), or **precise**: pick a player, scrub to a spot you recognise, "Set point", click their real location — twice, far apart — for an exact 2‑point fit. Saved per game build |

## How it's wired up

```
code ──▶ src/downloader.js ──▶ data/replays/<code>.replay      (fortnite-replay-downloader, unofficial Epic endpoint)
     ──▶ src/bridge.js ──────▶ dotnet run bridge/               (spawns the C# parser)
     ──▶ bridge/Program.cs ──▶ vendor/parser/ (FortniteReplayDecompressor, patched)
     ──▶ compact model JSON ─▶ data/parsed/<code>.json
     ──▶ /api/replays/:code/model ──▶ public/app.js  (canvas viewer + playback)

public/board.js ──▶ GET/PUT /api/board ──▶ src/board.js ──▶ data/board.json   (the home-screen board)
```

- **`src/`** — Express server. `store.js` runs one download+parse job per code,
  caches the result, and `clearCache()` wipes it (`DELETE /api/replays`);
  `routes.js` is the tiny JSON API; `board.js` validates and persists the
  home‑screen board (`data/board.json`, whole‑document GET/PUT).
- **`bridge/`** — a ~350‑line C# console app. It parses the replay and writes a
  compact model: per‑player position tracks (downsampled to ~3 Hz with movement
  flags), the storm phase timeline, health + shield readings, and the kill feed.
  Progress and errors go to stderr as JSON lines.
- **`vendor/parser/`** — a partial, **patched** copy of
  [Shiqan/FortniteReplayDecompressor](https://github.com/Shiqan/FortniteReplayDecompressor).
  See `vendor/parser/README.md` for the patches and why it's vendored.
- **`public/`** — the front end, no framework. `board.js` is the home‑screen
  board (drag/drop via `vendor/sortable.min.js`, a vendored copy of SortableJS);
  `app.js` is the viewer — one canvas, a `requestAnimationFrame` loop.
  `maps/hera.png` is the current 2048px map from `fortnite-api.com/images/map.png`
  (re-download it when the map changes).

## Why a C# parser

The only maintained Fortnite replay parser that reads current‑season replays is
the C# `FortniteReplayDecompressor`. The JS one (`fortnite-replay-parser`) has
been unmaintained since 2023 and cannot parse Chapter 7 replays at all. Even the
C# one needs three un‑merged community patches to read player movement from
build 41+ replays — those are applied in `vendor/parser/` (`PATCHES.diff`).

## Known limitations

- **Materials / inventory / weapons** aren't available. Fortnite retired the old
  `FortInventory` netfield; the current system (`ItemizationCoreRuntime.Inventory`)
  keeps the item list and counts inside a **Verse‑serialized struct**
  (`VerseInventoryInternal`) the Unreal property reader can't decode. Held
  weapons *do* replicate as blueprint actors, so "what's this player holding"
  is reachable with more work; wood/stone/metal counts need a Verse deserializer.
  The panel's materials row stays hidden until then.
- **No "who recorded this"** — build‑42 replays don't replicate the recorder id
  (or the aircraft, hence the inferred bus). So the timeline's elim/knock ticks
  follow whoever you've **selected**, not "you" automatically. Click your player.
- **Damage** — *taken* is derived from the health + shield timeline (every drop),
  and *storm* damage is the health‑only drops taken while outside the wall. Both
  are close for most players; a rare player whose pawn channel got recycled by
  the parser can read high. **Damage dealt** isn't available — the hit events
  name the weapon/projectile, not the shooter, so there's no attacker
  attribution (and no net damage / storm surge).
- **Map alignment** (`MAP_BOUNDS` in `public/app.js`) is a per‑axis 2‑point fit
  (the map render isn't square in world units — x and y need different scales),
  verified against two known positions to <1 px. If a Fortnite update moves the
  map: `npm run update-map`, then **Align → Set point** twice — pick a player, a
  moment you can place exactly, click the real spot; the two spots must be far
  apart in *both* directions — **Copy**, and paste the `ox/oy/wppuX/wppuY` line
  into `MAP_BOUNDS`. Note the storm `Radius` value is on a *different* scale than
  positions, so the first circle renders larger than the island — expected.
- When Fortnite ships a big update the parser can break until the patches in
  `vendor/parser/` are refreshed against a newer upstream.
- No auth, no cleanup of `data/` — it's a local tool.
