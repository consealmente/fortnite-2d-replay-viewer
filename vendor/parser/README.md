# Vendored replay parser

This is a **partial, patched copy** of [Shiqan/FortniteReplayDecompressor](https://github.com/Shiqan/FortniteReplayDecompressor)
(MIT). Only the four projects the bridge needs are included:

```
src/OozSharp            – Kraken/Mermaid decompressor (no deps)
src/Unreal.Encryption    – replay AES layer            (-> OozSharp)
src/Unreal.Core          – generic UE replay reader    (-> Logging.Abstractions)
src/FortniteReplayReader  – Fortnite-specific model     (-> Unreal.Core, Unreal.Encryption)
```

`UPSTREAM_COMMIT.txt` records the exact base commit. `PATCHES.diff` is the full set of
local changes on top of it.

## Why it's vendored instead of a NuGet reference

The released `FortniteReplayReader` 3.0.1 cannot read player movement from Chapter 7
(build 41.xx) replays — the pawn rotation field widened from 8 to 16 bits and the
released parser drops every pawn movement update as a result. The fixes only exist as
un-merged upstream pull requests, so the source is vendored with those applied.

## Patches applied

| Source | What |
|---|---|
| upstream PR #77 | build 41.00 pawn `RepMovement` rotation Byte→Short (this is what makes player tracks work at all) |
| upstream PR #75 | abort a packet whose bunch overflows it, instead of looping forever |
| upstream PR #78 | abort a bunch with a desynced content block, instead of looping forever |
| local | `Unreal.Core.ReplayReader.DemoFrameTimeSeconds` — exposes the current demo-frame timestamp to `OnExportRead` subclasses so per-tick data can be timestamped (the engine only carries this at the frame level, not per export) |
| local | **health/shield timeline** — `PlayerData.HealthTimeline` (`HealthSample`), populated by `FortniteReplayBuilder.UpdateHealth` from the `HealthSet` (`FortRegenHealthSet`) export. Upstream defines the `HealthSet` class but never reads it. |
| local | **shield handle fix** — build 41+/42.x moved current-shield from `FortRegenHealthSet` handle 19 → handle 30. `HealthSet.cs` maps both (all fields nullable so a partial update doesn't zero the others); `UpdateHealth` coalesces `handle30 ?? handle19 ?? last`. |

> **NB (2026-09-06):** PRs #77/#75/#78 are now merged & released upstream as
> v3.0.2–3.0.4 (v3.0.5 = CI). `PATCHES.diff` is stale — it never captured the
> health-timeline work either. This fork should be re-synced to the `3.0.5` tag
> (or swapped for the NuGet package) keeping only the four *local* rows above.

## Updating

When Fortnite breaks parsing again: check for a newer upstream release or new PRs,
re-vendor from a fresh checkout, and re-apply the **local** changes above. Keep
`UPSTREAM_COMMIT.txt` current.
