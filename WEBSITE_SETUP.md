# Public website deployment

The existing viewer is preserved. The Express server serves the website and runs the C# replay parser on the same Docker host. This is **not** a static Vercel deployment: parsing needs a .NET process and persistent disk.

## Deploy
1. Push this folder to a GitHub repository.
2. In Render, create a Blueprint using `render.yaml` (Docker web service + persistent disk). Confirm your plan supports persistent disks and the required disk size.
3. Wait for the Docker image to build; visit the assigned public URL. `/health` should return `{"status":"ok"}`.
4. Open a replay by code. Tournament replay codes depend on Epic retaining the replay file.

## Local
`npm ci && npm start` with the .NET 10 SDK installed, or `docker build -t fn-replay . && docker run -p 3000:3000 -v fnreplays:/app/data fn-replay`.

## Public website changes
- Visitors each have a board in their own browser localStorage (not a shared editable board). Clearing browser data removes that board; sharing a replay code still works.
- Shared cache deletion is disabled. Replay requests are rate-limited and active jobs capped.
- Parsed replays persist on a mounted disk. Capacity management and stronger abuse protection are needed before substantial public traffic.

## Inventory and materials accuracy
The viewer renders inventory snapshots when the parser emits them, and does not fabricate unknown values. Fortnite's current Verse inventory replication is not decoded by this project. Full item lists, wood/brick/metal history, rarity and accurate per-player equipped weapon labels are **not yet reliably available**. The C# parser now collects raw CurrentWeapon actor observations for future correlation; this is not a completed weapon-to-player timeline. Do not treat those features as complete until a real replay verifies them.
