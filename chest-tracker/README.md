# Standalone Fortnite chest tracker (single player)

This is an experimental, **headless** chest tracker using the existing vendored
Fortnite replay reader. It does not render maps, change the 2D viewer, or touch
its production deployment.

## Requirements

- Windows (or another OS that can run the existing .NET parser)
- .NET 10 SDK
- Node.js 18+ and `npm install` from the repository root (for the existing
  replay downloader)
- A finished local Fortnite `.replay` file

## Run

From the repository root:

```powershell
npm install
node chest-tracker/index.js "C:\Users\<you>\AppData\Local\FortniteGame\Saved\Demos\UnsavedReplay-xxxx.replay"
```

To scan only the local replay, without contacting Epic:

```powershell
node chest-tracker/index.js "C:\path\to\match.replay" --no-server
```

If the recorder cannot be identified from the replay, select the account
explicitly using its Epic account identifier:

```powershell
node chest-tracker/index.js "C:\path\to\match.replay" --epic-id YOUR_EPIC_ID
```

The command outputs JSON to stdout, including `chestCount`, a list of
`chests`, `matchCode`, `source`, local/server counts, and the outcome of the
server-replay attempt. Status messages go to stderr. The existing downloader
caches retrieved replays under `data/replays`.

## Automatic match tracking (no visualization)

For automatic counting after games, run:

```powershell
node chest-tracker/watch.js
```

The watcher checks the Fortnite Demos folder, waits for replay files to stop
changing, then runs the same local scan and server download attempt. The
persistent per-match history is written to `data/chest-tracker/history.json`.
It prints the latest count and cumulative total to the terminal.

Use `--folder "C:\path\to\Demos"` to override the default Windows folder.
Add `--no-server` if you do not want downloaded replays, or `--epic-id`
to select a single player explicitly.

## Dashboard (local browser app)

From the repository root, run:

```powershell
node chest-tracker/dashboard/server.js
```

Open **http://127.0.0.1:3407** on the same computer.

The dashboard is independent of the 2D viewer. It shows cumulative totals,
14-day activity bars, per-match counts, the source of each count, and chest
events. Import a completed `.replay` file by dropping it on the import area.
Optionally enter the number of chests you observed yourself; the dashboard
displays the difference, including in the match details.

The dashboard automatically starts the Fortnite Demos watcher when the folder
exists. It also supports:

```powershell
node chest-tracker/dashboard/server.js --folder "D:\Fortnite\Demos"
node chest-tracker/dashboard/server.js --no-watch
node chest-tracker/dashboard/server.js --no-server
node chest-tracker/dashboard/server.js --epic-id YOUR_EPIC_ID
```

The local dashboard binds only to **127.0.0.1** and runs on port **3407**.
Browser uploads (maximum 300 MB) are copied to a temporary local folder,
parsed, then removed. JSON match summaries remain in
`data/chest-tracker/imports.json`; watched results remain in `history.json`.
Replays with a matching match ID are deduplicated in the displayed totals.
No public deployment or authentication is configured.

**The parser's actual chest accuracy is still unverified:** one real current
Fortnite replay plus a manually observed count is the next required test.
All current automated checks use synthetic data and/or verify compilation.

## How it works

1. Read the local replay and extract `GameData.GameSessionId`.
2. Identify the recorder from `RecorderPlayerState` or the replay controller;
   map its PlayerState to its pawn(s).
3. Watch chest actor properties `SearchingPawn`, `bAlreadySearched`,
   `bDestroyed`, and `SearchAnimationCount`.
4. Count a chest only when a target pawn searched it and the actor was seen
   opening. Deduplicate repeated observations of the same actor.
5. If the session ID is a 32-hex-character code, try the existing server-replay
   downloader. When a server replay is available, scan it for the **same Epic
   account ID**, not whoever happens to be the recorder on that replay.
6. Use the downloaded count only when the player is positively identified and
   the downloaded replay has at least as many detected openings. Otherwise
   preserve the local count.

## Important limitations

- This is an initial implementation **not yet validated on a current-season
  sample replay**. Event names and replay layouts can change after updates.
- It counts chest actors, not all containers (e.g. ammo boxes).
- Chest actor events outside the client's replay region may be absent.
- Match IDs are not necessarily available or downloadable, especially for
  ordinary public matches. Server downloads can fail for unrelated reasons,
  including retention, availability, and permissions.
- If player ownership cannot be resolved, `chestCount` is **null**, not zero.
- If an Epic account ID cannot be extracted from the local recording, the tool
  will not attribute the server replay to an arbitrary player.
- Server-side availability does not prove that all chest events are replicated.
  Compare counts with a controlled match before relying on totals.

## Tests

```sh
node --test chest-tracker/result.test.js
dotnet build chest-tracker/chest-tracker.csproj -c Release
```

A real replay is required for an integration test and for validating chest
detection. This implementation intentionally leaves the existing viewer,
`src/store.js`, and its Express API unchanged.
