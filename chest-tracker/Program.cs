using System.Text.Json;
using FortniteReplayReader;
using FortniteReplayReader.Models;
using FortniteReplayReader.Models.NetFieldExports;
using Unreal.Core;
using Unreal.Core.Attributes;
using Unreal.Core.Contracts;
using Unreal.Core.Models;
using Unreal.Core.Models.Enums;

// A standalone replay inspector; it does not change the 2D viewer or its parser output.
if (args.Length < 1 || !File.Exists(args[0]))
{
    Console.Error.WriteLine("Usage: dotnet run --project chest-tracker -- <file.replay> [--epic-id <id>]");
    return 2;
}

string? epicId = null;
for (var i = 1; i < args.Length; i++)
{
    if (args[i] == "--epic-id" && i + 1 < args.Length)
        epicId = args[++i];
    else
    {
        Console.Error.WriteLine("Unknown or incomplete argument: " + args[i]);
        return 2;
    }
}

try
{
    var reader = new ChestScanReader();
    var replay = reader.ReadReplay(args[0]);
    var result = reader.Summarize(replay, epicId);
    Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    }));
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex);
    return 1;
}

// Handles the replay spectator-controller's special network opening payload.
[PlayerController("BP_ReplayPC_Athena_C")]
internal sealed class ReplayControllerMarker { }

internal sealed record ChestChange(double Time, string Id, string ClassName,
    uint? SearchingPawn, bool? Searched, bool? Destroyed, int? AnimationCount)
{
    public bool Opened => Searched == true || Destroyed == true || AnimationCount > 0;
}

internal sealed record ChestOpened(double Time, string ChestId, string ChestClass);

// The game does not expose every chest through the normal typed netfield exports.
// Read a small set of chest properties directly from the network property stream.
internal sealed class ChestScanReader : ReplayReader
{
    private enum GroupKind { Other, Chest, ReplayController }
    private readonly Dictionary<string, GroupKind> _groupKinds = new(StringComparer.Ordinal);
    private readonly Dictionary<uint, uint> _pawnToState = new();
    private readonly Dictionary<uint, string> _stateToEpicId = new();
    private readonly Dictionary<uint, string> _spawnIds = new();
    private readonly List<(string Kind, double X, double Y, string Id)> _spawned = new();
    private readonly List<ChestChange> _changes = new();
    private uint? _recorderState;
    private uint? _controllerState;

    public ChestScanReader() : base(null, ParseMode.Full) { }

    protected override void OnExportRead(uint channelIndex, INetFieldExportGroup? exportGroup)
    {
        switch (exportGroup)
        {
            case GameState game when game.RecorderPlayerState is ActorGuid recorder:
                _recorderState ??= recorder.Value;
                break;
            case PlayerPawn pawn when pawn.PlayerState is uint state:
                if (Channels[channelIndex]?.ActorId is uint pawnId)
                    _pawnToState[pawnId] = state;
                break;
            case FortPlayerState player:
                if (Channels[channelIndex]?.ActorId is uint stateId)
                {
                    var id = player.UniqueId ?? player.UniqueID;
                    if (!string.IsNullOrWhiteSpace(id))
                        _stateToEpicId[stateId] = id;
                }
                break;
        }
        base.OnExportRead(channelIndex, exportGroup);
    }

    private GroupKind IdentifyGroup(string path)
    {
        if (_groupKinds.TryGetValue(path, out var kind)) return kind;
        kind = GroupKind.Other;
        if (!path.Contains(':') && !path.EndsWith("ClassNetCache", StringComparison.Ordinal))
        {
            var name = path[(path.LastIndexOf('.') + 1)..];
            if (name.Contains("Chest", StringComparison.OrdinalIgnoreCase))
                kind = GroupKind.Chest;
            else if (name.Contains("ReplayPC", StringComparison.OrdinalIgnoreCase))
                kind = GroupKind.ReplayController;
        }
        _groupKinds[path] = kind;
        return kind;
    }

    public override bool ReceiveProperties(FBitArchive archive, NetFieldExportGroup group,
        uint channelIndex, out INetFieldExportGroup? exportGroup,
        bool enablePropertyChecksum = true, bool netDeltaUpdate = false)
    {
        var kind = netDeltaUpdate ? GroupKind.Other : IdentifyGroup(group.PathName);
        if (kind == GroupKind.Other)
            return base.ReceiveProperties(archive, group, channelIndex,
                out exportGroup, enablePropertyChecksum, netDeltaUpdate);

        exportGroup = null;
        if (Channels[channelIndex] is null) return false;
        if (enablePropertyChecksum) archive.ReadBit();

        uint? searchingPawn = null;
        uint? controllerState = null;
        bool? searched = null, destroyed = null;
        int? animationCount = null;

        while (true)
        {
            var handle = archive.ReadIntPacked();
            if (handle == 0) break;
            handle--;
            if (!group.IsValidIndex(handle)) return false;
            var bits = (int)archive.ReadIntPacked();
            if (bits == 0) continue;
            if (archive.IsError || bits > archive.GetBitsLeft()) return false;

            var remainingBefore = archive.GetBitsLeft();
            var property = group.NetFieldExports[handle]?.Name;
            switch (kind, property)
            {
                case (GroupKind.Chest, "SearchingPawn"):
                    searchingPawn = archive.ReadIntPacked();
                    break;
                case (GroupKind.Chest, "bAlreadySearched"):
                    searched = archive.ReadBit();
                    break;
                case (GroupKind.Chest, "bDestroyed"):
                    destroyed = archive.ReadBit();
                    break;
                case (GroupKind.Chest, "SearchAnimationCount") when bits <= 32:
                    animationCount = archive.ReadBitsToInt(bits);
                    break;
                case (GroupKind.ReplayController, "PlayerState"):
                    controllerState = archive.ReadIntPacked();
                    break;
            }

            var consumed = remainingBefore - archive.GetBitsLeft();
            if (archive.IsError || consumed > bits) return false;
            if (consumed < bits) archive.SkipBits(bits - consumed);
        }

        if (kind == GroupKind.ReplayController && controllerState is > 0)
            _controllerState ??= controllerState;

        if (kind == GroupKind.Chest
            && Channels[channelIndex]?.ActorId is uint actor
            && (searchingPawn.HasValue || searched.HasValue
                || destroyed.HasValue || animationCount.HasValue))
        {
            var channel = Channels[channelIndex]!;
            var className = group.PathName[(group.PathName.LastIndexOf('.') + 1)..];
            var id = GetChestId(actor, channel.Actor?.Location, className);
            _changes.Add(new ChestChange(DemoFrameTimeSeconds, id, className,
                searchingPawn, searched, destroyed, animationCount));
        }
        return !archive.IsError;
    }

    private string GetChestId(uint actor, FVector? position, string className)
    {
        if (_netGuidCache.TryGetPathName(actor, out var pathName))
            return pathName;
        if (_spawnIds.TryGetValue(actor, out var existing))
            return existing;

        string id;
        if (position is null)
            id = $"actor:{actor}";
        else
        {
            // Some treasure chests respawn in view with new actor network IDs.
            // The horizontal location and class provide a fallback stable key.
            var near = _spawned.FirstOrDefault(x => x.Kind == className
                && Math.Abs(x.X - position.X) < 150
                && Math.Abs(x.Y - position.Y) < 150);
            id = near.Id ?? $"{className}@{position.X:F0},{position.Y:F0}";
            if (near.Id is null)
                _spawned.Add((className, position.X, position.Y, id));
        }

        _spawnIds[actor] = id;
        return id;
    }

    public object Summarize(FortniteReplay replay, string? requestedEpicId)
    {
        var recorderState = _recorderState ?? replay.GameData.RecorderId ?? _controllerState;
        var recorderEpicId = recorderState is uint ps
            && _stateToEpicId.TryGetValue(ps, out var resolved)
                ? resolved : null;
        var targetEpicId = requestedEpicId ?? recorderEpicId;

        var targetStates = new HashSet<uint>();
        if (!string.IsNullOrWhiteSpace(targetEpicId))
        {
            foreach (var (state, id) in _stateToEpicId)
                if (string.Equals(id, targetEpicId, StringComparison.OrdinalIgnoreCase))
                    targetStates.Add(state);
        }
        // Local replays can expose recorder PlayerState without exposing its Epic ID.
        if (requestedEpicId is null && recorderState is uint localState)
            targetStates.Add(localState);

        var targetPawns = _pawnToState
            .Where(p => targetStates.Contains(p.Value))
            .Select(p => p.Key)
            .ToHashSet();

        var events = new List<ChestOpened>();
        var openedVisible = 0;
        foreach (var chest in _changes.GroupBy(x => x.Id))
        {
            var history = chest.ToList();
            var firstSearch = history.FindIndex(x => x.SearchingPawn is uint pawn
                && targetPawns.Contains(pawn));
            if (firstSearch >= 0 && history.Skip(firstSearch).Any(x => x.Opened))
            {
                var search = history[firstSearch];
                events.Add(new ChestOpened(Math.Round(search.Time, 2), search.Id,
                    search.ClassName));
            }
            if (history.Any(x => x.SearchingPawn is > 0 && x.Opened)
                || (history.Any(x => x.Opened)
                    && history.Any(x => x.Searched == false)))
                openedVisible++;
        }
        events.Sort((a, b) => a.Time.CompareTo(b.Time));

        var name = replay.PlayerData.FirstOrDefault(x =>
            string.Equals(x.EpicId, targetEpicId, StringComparison.OrdinalIgnoreCase))
            ?.PlayerName;
        var resolvedPlayer = targetPawns.Count > 0;
        return new {
            sessionId = replay.GameData.GameSessionId,
            replayGuid = replay.Header.Guid,
            playlist = replay.GameData.CurrentPlaylist,
            recorderState,
            recorderEpicId,
            targetEpicId,
            playerName = name,
            playerResolved = resolvedPlayer,
            count = resolvedPlayer ? (int?)events.Count : null,
            chestEvents = events,
            visibleOpenedChests = openedVisible,
            scannedChestActors = _changes.Select(x => x.Id).Distinct().Count(),
            warning = resolvedPlayer ? null : "Player identity could not be mapped to a pawn; count is unknown, not zero."
        };
    }
}
