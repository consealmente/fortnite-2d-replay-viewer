using Unreal.Core.Attributes;
using Unreal.Core.Contracts;
using Unreal.Core.Models.Enums;

namespace FortniteReplayReader.Models.NetFieldExports;

// FortRegenHealthSet is a GameplayAbilitySystem AttributeSet -- every field is a
// float, replicated by handle. Handle numbers drift between Fortnite builds:
//   health current : 0 / 1
//   health max     : 3 / 11 / 18
//   shield current : 19  up to ~build 40, then 30 on build 41+/42.x (mirrors 31/37/38)
//   shield max     : 20 / 21 / 27 / 28 / 33
// Each replication update only carries the handles that changed, so every field
// is nullable: null = "not in this update", a value (including 0) = "sent".
[NetFieldExportGroup("/Script/FortniteGame.FortRegenHealthSet", minimalParseMode: ParseMode.Full)]
public class HealthSet : INetFieldExportGroup
{
    [NetFieldExportHandle(0, RepLayoutCmdType.PropertyFloat)]
    public float? HealthBaseValue { get; set; }

    [NetFieldExportHandle(1, RepLayoutCmdType.PropertyFloat)]
    public float? HealthCurrentValue { get; set; }

    [NetFieldExportHandle(3, RepLayoutCmdType.PropertyFloat)]
    public float? HealthMaxValue { get; set; }

    [NetFieldExportHandle(19, RepLayoutCmdType.PropertyFloat)]
    public float? ShieldCurrentValueLegacy { get; set; }

    [NetFieldExportHandle(21, RepLayoutCmdType.PropertyFloat)]
    public float? ShieldMaxValue { get; set; }

    // build 41+/42.x: current shield lives here now (mirrors on handles 31/37/38).
    [NetFieldExportHandle(30, RepLayoutCmdType.PropertyFloat)]
    public float? ShieldCurrentValue { get; set; }
}
