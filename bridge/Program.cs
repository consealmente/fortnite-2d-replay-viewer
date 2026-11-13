using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using FortniteReplayReader;
using FortniteReplayReader.Models.NetFieldExports;
using Unreal.Core.Contracts;
using Unreal.Core.Models;
using Unreal.Core.Models.Enums;

// ---------------------------------------------------------------------------
// bridge: reads a .replay file and writes a compact JSON model for the 2D
// replay viewer (public/app.js).
//
//   bridge <input.replay> <output.json>
//
// stderr carries newline-delimited JSON for the Node parent:
//   {"progress": <0..100>}          - coarse progress ticks
//   {"error": "...", "type": "..."} - a parse failure (exit code 1)
// stdout is left for dotnet's own build/run noise and is ignored by Node.
//
// Player positions come from replay.PlayerData[].Locations, which the vendored
// (patched) FortniteReplayReader populates from pawn ReplicatedMovement at
// ParseMode.Full. The storm timeline is captured live in OnExportRead because
// SafeZoneIndicator sends the phase geometry once per phase and then streams
// only the shrinking radius - the final MapData.SafeZones list loses the
// in-between frames.
// ---------------------------------------------------------------------------

if (args.Length < 2)
{
    Console.Error.WriteLine("{\"error\":\"usage: bridge <input.replay> <output.json>\",\"type\":\"Usage\"}");
    Environment.Exit(2);
    return;
}

var inputPath = args[0];
var outputPath = args[1];

void Progress(int pct) => Console.Error.WriteLine($"{{\"progress\":{pct}}}");

try
{
    Progress(3);
    var reader = new ViewerReader(Progress);
    var replay = reader.ReadReplay(inputPath);
    Progress(75);

    var model = ViewerModel.Build(replay, reader);
    Progress(95);

    var json = JsonSerializer.Serialize(model, new JsonSerializerOptions
    {
        WriteIndented = false,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    });
    File.WriteAllText(outputPath, json);
    Progress(100);
}
catch (Exception ex)
{
    var payload = JsonSerializer.Serialize(new
    {
        error = ex.Message,
        type = ex.GetType().FullName,
        stack = ex.StackTrace,
    });
    Console.Error.WriteLine(payload);
    Environment.Exit(1);
}

// ---------------------------------------------------------------------------

/// <summary>
/// ReplayReader subclass that snapshots the storm indicator and the game
/// clock as the packet stream is walked. DemoFrameTimeSeconds (a local patch
/// on Unreal.Core.ReplayReader) is the wall-clock time of the frame currently
/// being processed.
/// </summary>
class ViewerReader : ReplayReader
{
    private readonly Action<int> _progress;
    private int _lastPct = 3;

    public readonly List<StormSample> StormSamples = new();
    public readonly List<InventoryObservation> InventoryObservations = new();
    public readonly List<WeaponObservation> WeaponObservations = new();
    public readonly List<(double demo, double clock)> ClockPairs = new();

    public ViewerReader(Action<int> progress) : base(null, ParseMode.Full)
    {
        _progress = progress;
    }

    protected override void OnExportRead(uint channelIndex, INetFieldExportGroup exportGroup)
    {
        switch (exportGroup)
        {
            case GameState gs:
            {
                var clock = gs.ReplicatedWorldTimeSecondsDouble ?? gs.ReplicatedWorldTimeSeconds ?? 0;
                if (clock > 0)
                {
                    ClockPairs.Add((DemoFrameTimeSeconds, clock));
                    // Very coarse progress: the clock climbs steadily across the match.
                    var pct = 5 + (int)Math.Min(65, ClockPairs.Count / 220.0);
                    if (pct > _lastPct) { _lastPct = pct; _progress(pct); }
                }
                break;
            }
            case PlayerPawn pawn:
            {
                if (pawn.CurrentWeapon.HasValue)
                    WeaponObservations.Add(new WeaponObservation {
                        DemoTime = DemoFrameTimeSeconds, Channel = channelIndex,
                        WeaponActor = pawn.CurrentWeapon.Value
                    });
                break;
            }
            case FortInventory inv:
            {
                if (inv.A.HasValue && inv.ItemDefinition?.Name != null)
                    InventoryObservations.Add(new InventoryObservation
                    {
                        DemoTime = DemoFrameTimeSeconds, Channel = channelIndex,
                        Slot = inv.OrderIndex, Name = inv.ItemDefinition.Name,
                        Count = inv.Count, Ammo = inv.LoadedAmmo,
                    });
                break;
            }
            case SafeZoneIndicator sz:
            {
                StormSamples.Add(new StormSample
                {
                    DemoTime = DemoFrameTimeSeconds,
                    Radius = sz.Radius,
                    PreviousRadius = sz.PreviousRadius,
                    NextRadius = sz.NextRadius,
                    Phase = float.IsNormal(sz.CurrentPhase) ? sz.CurrentPhase : 0,
                    PreviousCenter = V(sz.PreviousCenter) ?? V(sz.LastCenter),
                    NextCenter = V(sz.NextCenter),
                    StartShrinkTime = sz.SafeZoneStartShrinkTime,
                    FinishShrinkTime = sz.SafeZoneFinishShrinkTime,
                });
                break;
            }
        }

        base.OnExportRead(channelIndex, exportGroup);
    }

    private static double[] V(FVector v) =>
        v is null || (v.X == 0 && v.Y == 0) ? null : new[] { Math.Round(v.X, 1), Math.Round(v.Y, 1) };
}

/// <summary>One resolved storm phase, serialized straight into the model JSON.</summary>
class PhaseOut
{
    public int phase { get; set; }
    public double? announcedAt { get; set; }
    public double radius { get; set; }
    public double[] center { get; set; }
    public double nextRadius { get; set; }
    public double[] nextCenter { get; set; }
    public double startShrink { get; set; }
    public double finishShrink { get; set; }
}

class WeaponObservation
{
    public double DemoTime { get; set; }
    public uint Channel { get; set; }
    public uint WeaponActor { get; set; }
}

class InventoryObservation
{
    public double DemoTime { get; set; }
    public uint Channel { get; set; }
    public ushort? Slot { get; set; }
    public string Name { get; set; }
    public int? Count { get; set; }
    public int? Ammo { get; set; }
}

class StormSample
{
    public double DemoTime { get; set; }
    public float Radius { get; set; }
    public float PreviousRadius { get; set; }
    public float NextRadius { get; set; }
    public float Phase { get; set; }
    public double[] PreviousCenter { get; set; }
    public double[] NextCenter { get; set; }
    public float StartShrinkTime { get; set; }
    public float FinishShrinkTime { get; set; }
}

// ---------------------------------------------------------------------------

static class ViewerModel
{
    // Position sampling for the output track. The raw stream is ~14 Hz; the
    // viewer interpolates, so a lower rate is plenty - but always keep a
    // sample when a movement flag flips so state changes land on time.
    const double MinSampleDt = 0.35;

    public static object Build(FortniteReplayReader.Models.FortniteReplay replay, ViewerReader reader)
    {
        // matchClock = demoTime + clockOffset. Player LastUpdateTime and the
        // safe-zone shrink times are already in match-clock seconds; only the
        // live storm-radius samples (captured in demo time) need shifting.
        double clockOffset = Median(reader.ClockPairs.Select(p => p.clock - p.demo).ToList());
        if (double.IsNaN(clockOffset)) clockOffset = 0;

        var players = replay.PlayerData.Where(p => p.Locations is { Count: > 0 }).ToList();

        // The engine records a "death" for the winner too (at match end cleanup);
        // and stray kill-feed rows land in the last couple of seconds. Anything
        // at/after this cutoff is game-over bookkeeping, not real gameplay.
        double matchEndCut = (replay.GameData.MatchEndTime ?? 1e9) - 2.5;
        var winners = new HashSet<int>(replay.GameData.WinningPlayerIds ?? Enumerable.Empty<int>());

        // Everyone spawns on the pre-game island, far from the play area. Find
        // that blob from the first sample of every player and drop samples
        // sitting in it - the viewer is about the match, not the lobby.
        var firstPts = players
            .Select(p => p.Locations[0].ReplicatedMovement?.Location)
            .Where(l => l != null)
            .ToList();
        double islandX = Median(firstPts.Select(l => l.X).ToList());
        double islandY = Median(firstPts.Select(l => l.Y).ToList());
        const double islandHalf = 60000;
        bool OnIsland(FVector l) =>
            Math.Abs(l.X - islandX) < islandHalf && Math.Abs(l.Y - islandY) < islandHalf;

        var outPlayers = new List<object>();
        double dataMinX = double.MaxValue, dataMinY = double.MaxValue, dataMaxX = double.MinValue, dataMaxY = double.MinValue;
        double matchStart = double.MaxValue, matchEnd = double.MinValue;

        foreach (var p in players)
        {
            var track = new List<double[]>();
            double lastKept = double.NegativeInfinity;
            int lastFlags = -1;
            var locs = p.Locations;

            for (int i = 0; i < locs.Count; i++)
            {
                var m = locs[i];
                var loc = m.ReplicatedMovement?.Location;
                if (loc == null) continue;
                if (OnIsland(loc)) continue;

                double t = m.LastUpdateTime ?? m.ReplicatedWorldTimeSecondsDouble ?? 0;
                if (t <= 0) continue;

                int flags = Flags(m);
                bool last = i == locs.Count - 1;
                if (!last && flags == lastFlags && (t - lastKept) < MinSampleDt) continue;

                int yaw = (int)Math.Round(m.ReplicatedMovement?.Rotation?.Yaw ?? 0);
                track.Add(new[] { Math.Round(t, 2), Math.Round(loc.X), Math.Round(loc.Y), Math.Round(loc.Z), flags, yaw });
                lastKept = t;
                lastFlags = flags;

                if (loc.X < dataMinX) dataMinX = loc.X;
                if (loc.X > dataMaxX) dataMaxX = loc.X;
                if (loc.Y < dataMinY) dataMinY = loc.Y;
                if (loc.Y > dataMaxY) dataMaxY = loc.Y;
            }

            if (track.Count == 0) continue;

            double first = track[0][0];
            double lastT = track[^1][0];
            if (first < matchStart) matchStart = first;
            if (lastT > matchEnd) matchEnd = lastT;

            object death = null;
            var dl = p.DeathLocation;
            double? dt = p.DeathTimeDouble ?? p.DeathTime;
            bool won = p.Id != null && winners.Contains(p.Id.Value);
            if (dt is > 0 && dt.Value < matchEndCut && !won)
            {
                death = new
                {
                    t = Math.Round(dt.Value, 2),
                    cause = p.DeathCause,
                    x = dl != null && dl.Size() != 0 ? Math.Round(dl.X) : (double?)null,
                    y = dl != null && dl.Size() != 0 ? Math.Round(dl.Y) : (double?)null,
                };
            }

            // Health timeline: [t, health, shield]. Fortnite health/shield maxes
            // are always 100, and the max handle reads unreliably, so just clamp.
            // Shield comes from FortRegenHealthSet handle 30 on build 41+ (it was
            // handle 19 before). Game-over resets dropped.
            double hpCut = Math.Min(matchEndCut, (dt is > 0 && !won) ? dt.Value : matchEndCut);
            var hp = p.HealthTimeline
                .Where(h => h.Time > 0 && h.Time < hpCut)
                .Select(h => new[]
                {
                    Math.Round(h.Time, 2),
                    Math.Round(Math.Clamp(h.Health, 0, 100)),
                    Math.Round(Math.Clamp(h.Shield, 0, 100)),
                })
                .ToList();
            // Collapse consecutive identical readings left after clamping.
            hp = hp.Where((h, i) => i == 0 || h[1] != hp[i - 1][1] || h[2] != hp[i - 1][2]).ToList();

            // Only publish inventory changes tied to a resolved player inventory.
            // An observation is a partial update, not proof of a complete loadout.
            var inventoryHistory = new List<object[]>();
            if (p.InventoryId is uint inventoryChannel)
            {
                var slots = new Dictionary<int, object>();
                foreach (var obs in reader.InventoryObservations
                    .Where(o => o.Channel == inventoryChannel && o.Slot.HasValue)
                    .OrderBy(o => o.DemoTime))
                {
                    int slot = obs.Slot.Value;
                    if (slot < 0 || slot >= 5) continue;
                    slots[slot] = new { slot, name = obs.Name, count = obs.Count, ammo = obs.Ammo };
                    inventoryHistory.Add(new object[] {
                        Math.Round(obs.DemoTime + clockOffset, 2),
                        slots.Values.ToArray(),
                        null,
                        null
                    });
                }
            }

            outPlayers.Add(new
            {
                id = p.Id,
                epicId = p.EpicId,
                name = string.IsNullOrEmpty(p.PlayerName) ? (p.IsBot ? "Bot" : "Unknown") : p.PlayerName,
                isBot = p.IsBot,
                team = p.TeamIndex,
                placement = p.Placement,
                kills = p.Kills,
                character = p.Cosmetics?.Character,
                spawnTime = Math.Round(first, 2),
                death,
                track,
                hp = hp.Count > 0 ? hp : null,
                inventory = inventoryHistory.Count > 0 ? inventoryHistory : null,
            });
        }

        // ---- Storm phases: merge the once-per-phase geometry announcements
        // with the streamed radius so the viewer can draw an exact circle at
        // any moment. Each phase entry: the circle holds at `radius` centered
        // at `center` until `startShrink`, then lerps to `nextRadius`/`nextCenter`
        // finishing at `finishShrink` (all match-clock seconds).
        var announces = reader.StormSamples
            .Where(s => s.StartShrinkTime > 0 && s.FinishShrinkTime > s.StartShrinkTime && s.NextRadius > 0)
            .GroupBy(s => Math.Round(s.StartShrinkTime, 1))
            .Select(g => g.First())
            .OrderBy(s => s.StartShrinkTime)
            .ToList();

        var phaseList = new List<PhaseOut>();
        for (int i = 0; i < announces.Count; i++)
        {
            var a = announces[i];
            // The circle this phase starts from: its own PreviousCenter if it
            // carried one, otherwise the previous phase's resolved next-center,
            // otherwise the world origin.
            double[] center = a.PreviousCenter
                ?? (i > 0 ? phaseList[i - 1].nextCenter : null)
                ?? new double[] { 0, 0 };
            double radius = a.PreviousRadius > 0 ? a.PreviousRadius
                : i > 0 ? phaseList[i - 1].nextRadius
                : a.Radius;
            phaseList.Add(new PhaseOut
            {
                phase = i + 1,
                announcedAt = Math.Round(a.DemoTime + clockOffset, 2),
                radius = Math.Round(radius),
                center = center,
                nextRadius = Math.Round(a.NextRadius),
                nextCenter = a.NextCenter ?? center,
                startShrink = Math.Round(a.StartShrinkTime, 2),
                finishShrink = Math.Round(a.FinishShrinkTime, 2),
            });
        }

        // Fallback: if live capture missed the announcements, use the final list.
        if (phaseList.Count == 0)
        {
            for (int i = 0; i < replay.MapData.SafeZones.Count; i++)
            {
                var z = replay.MapData.SafeZones[i];
                var prev = i > 0 ? replay.MapData.SafeZones[i - 1] : null;
                phaseList.Add(new PhaseOut
                {
                    phase = i + 1,
                    radius = Math.Round(z.Radius),
                    center = prev?.NextCenter != null ? new[] { Math.Round(prev.NextCenter.X), Math.Round(prev.NextCenter.Y) } : new double[] { 0, 0 },
                    nextRadius = Math.Round(z.NextRadius),
                    nextCenter = z.NextCenter != null ? new[] { Math.Round(z.NextCenter.X), Math.Round(z.NextCenter.Y) } : new double[] { 0, 0 },
                    startShrink = Math.Round(z.StartShrinkTime, 2),
                    finishShrink = Math.Round(z.FinishShrinkTime, 2),
                });
            }
        }
        var phases = phaseList;

        // Live shrink radius samples (for a perfectly smooth wall even if the
        // shrink is non-linear). Converted demo -> match clock.
        var stormRadius = reader.StormSamples
            .Where(s => s.Radius > 0)
            .Select(s => new[] { Math.Round(s.DemoTime + clockOffset, 2), Math.Round(s.Radius) })
            .Where(a => a[0] > 0)
            .ToList();

        // ---- Kill feed / elimination markers (match-clock aligned).
        // Name lookup covers every player, not just the ones with position
        // tracks -- kill-feed rows reference people who never left the bus too.
        var idToName = replay.PlayerData
            .Where(p => p.Id != null)
            .GroupBy(p => p.Id.Value)
            .ToDictionary(
                g => g.Key,
                g => g.Select(x => x.PlayerName).FirstOrDefault(n => !string.IsNullOrEmpty(n))
                     ?? (g.Any(x => x.IsBot) ? "Bot" : null));

        var events = replay.KillFeed
            .Select(k => new
            {
                t = Math.Round(k.ReplicatedWorldTimeSecondsDouble ?? k.ReplicatedWorldTimeSeconds ?? 0, 2),
                victim = k.PlayerId,
                victimName = k.PlayerId != null && idToName.TryGetValue(k.PlayerId.Value, out var vn) ? vn : k.PlayerName,
                killer = k.FinisherOrDowner,
                killerName = k.FinisherOrDowner != null && idToName.TryGetValue(k.FinisherOrDowner.Value, out var kn) ? kn : k.FinisherOrDownerName,
                cause = k.DeathCause,
                distance = k.Distance != null ? Math.Round(k.Distance.Value) : (double?)null,
                downed = k.IsDowned,
                revived = k.IsRevived,
                x = k.DeathLocation != null && k.DeathLocation.Size() != 0 ? Math.Round(k.DeathLocation.X) : (double?)null,
                y = k.DeathLocation != null && k.DeathLocation.Size() != 0 ? Math.Round(k.DeathLocation.Y) : (double?)null,
            })
            .Where(e => e.t > 0 && e.t < matchEndCut)
            .OrderBy(e => e.t)
            .ToList();

        if (matchStart == double.MaxValue) { matchStart = 0; matchEnd = replay.Info.LengthInMs / 1000.0; }

        // Calibration hint: the first full circle is centered near the world
        // origin; its radius bounds the play area. The viewer starts from this
        // and lets the user nudge.
        var firstPhase = phases.Count > 0 ? phases[0] : null;
        double[] hintCenter = firstPhase?.center ?? new double[] { 0, 0 };
        double hintRadius = firstPhase?.radius ?? 150000d;

        return new
        {
            meta = new
            {
                schemaVersion = 2,
                safeZonesStartTime = replay.GameData.SafeZonesStartTime,
                friendlyName = replay.Info.FriendlyName,
                playlist = replay.GameData.CurrentPlaylist,
                branch = replay.Header.Branch,
                build = reader.Major > 0 ? $"{reader.Major}.{reader.Minor:00}" : null,
                changelist = replay.Info.Changelist,
                lengthMs = replay.Info.LengthInMs,
                recordedUtc = replay.Info.Timestamp,
                utcMatchStart = replay.GameData.UtcTimeStartedMatch,
                matchEndTime = replay.GameData.MatchEndTime,
                winningTeam = replay.GameData.WinningTeam,
                winningPlayerIds = replay.GameData.WinningPlayerIds,
                maxPlayers = replay.GameData.MaxPlayers,
                teamSize = replay.GameData.TeamSize,
                playerCount = outPlayers.Count,
                clockOffset = Math.Round(clockOffset, 3),
            },
            time = new
            {
                start = Math.Round(matchStart, 2),
                end = Math.Round(Math.Max(matchEnd, replay.GameData.MatchEndTime ?? matchEnd), 2),
            },
            world = new
            {
                dataBounds = new[] { Math.Round(dataMinX), Math.Round(dataMinY), Math.Round(dataMaxX), Math.Round(dataMaxY) },
                stormCenter = hintCenter,
                stormRadius = hintRadius,
            },
            weaponObservations = reader.WeaponObservations.Select(o => new object[] {
                Math.Round(o.DemoTime + clockOffset, 2), o.Channel, o.WeaponActor
            }).ToArray(),
            players = outPlayers,
            storm = phases,
            stormRadius,
            events,
        };
    }

    static int Flags(FortniteReplayReader.Models.PlayerMovement m)
    {
        int f = 0;
        if (m.bIsDBNO == true) f |= 1;
        if (m.bIsSkydiving == true) f |= 2;
        if (m.bIsParachuteOpen == true) f |= 4;
        if (m.bIsInAnyStorm == true) f |= 8;
        if (m.bIsSkydivingFromBus == true) f |= 16;
        if (m.bIsSprinting == true) f |= 32;
        if (m.bIsTargeting == true) f |= 64;
        if (m.bIsZiplining == true) f |= 128;
        return f;
    }

    static double Median(List<double> xs)
    {
        if (xs == null || xs.Count == 0) return double.NaN;
        var s = xs.Where(x => !double.IsNaN(x)).OrderBy(x => x).ToList();
        if (s.Count == 0) return double.NaN;
        return s.Count % 2 == 1 ? s[s.Count / 2] : (s[s.Count / 2 - 1] + s[s.Count / 2]) / 2;
    }
}
