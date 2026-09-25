# Object Tracker

Object Tracker is an Adobe Premiere Pro 26+ CEP panel. It reads tracking data from the saved Premiere project and writes editable keyframes to a selected target clip.

## Use it

1. Select one timeline video clip that has a tracked classic mask or Object Mask.
2. Save the Premiere project once. Choose Read Track Source. The project and its adjacent Masks folder must be available.
3. Select a different video or graphic clip in the same sequence. Choose Follow or Stabilize and click Apply to Selected Target.
4. Use Clear Generated Keys on Selected Target to remove only Object Tracker keys that still match their recorded time and value.

The source is the clip with the mask. The target is the clip that receives motion.

## Modes

| Mode | What it writes | Bounds and scale |
|---|---|---|
| Follow | Transform Position keys move the target by the tracked center's change from the first overlapping frame. The target's existing Transform Position is the placement baseline. | Optional Auto Scale changes Transform Scale from validated Object Mask width and height. It keeps the target's starting scale as the reference. |
| Stabilize | Inverse movement keys on the target clip's built-in Motion Position. | It does not add Transform, change Scale, or put the Object Mask on the target. Auto Scale is disabled. |

The target clip's Position must not already be animated. Follow with Auto Scale also requires readable, unanimated Transform Scale. Object Tracker stops when those values cannot be safely read or written. It verifies generated keys and attempts rollback after write failures. Clearing preserves keys the user has edited.

Auto Scale multiplies the starting scale by the square root of the product of current-to-reference mask width and height ratios. The graphic grows with the tracked object and shrinks as it gets smaller. This scales the target as a whole; it does not fit the visible pixels or transparent edges of a PNG to the mask. The removed Fit target frame option is not part of the current panel.

## Supported tracking data

- Premiere 26.x Object Mask: resolves the selected mask tracker's UUID sidecar references and decodes validated per-frame rectangles and times from PRMF v3 files. The reader checks record layout, payload ranges, source dimensions, clip timing, and continuous frame coverage before reporting geometry or enabling Auto Scale.
- Classic AEMask2: reads the observed 104-byte Tracker samples on Premiere 26.x and supplies point motion only. It has no validated per-frame bounds, so Auto Scale is unavailable.
- Premiere 27.x parsing is disabled until the private data layouts are independently validated. Rotation is not decoded.

Object Mask classification comes from the selected tracker's linked PRMF sidecars, not a private component hash. Single-record sidecars are kept as reference data and are not mistaken for a motion timeline.

## Known limits

- The decoder reads rectangle metadata in the PRMF trailer. The high-entropy mask image payload remains undecoded; it is not needed for center and size.
- Follow keeps the target's chosen placement. It does not inspect a graphic's visible artwork, PNG transparency, internal crop, or anchor to align those pixels to the mask. Place the target where it should sit on the first tracked frame.
- Position conversion uses source and sequence frame dimensions. It does not apply source Motion Scale, rotation, pixel aspect ratio, or nested-sequence transforms. These can affect alignment in some projects.
- Object Mask rotation and perspective are unsupported. Auto Scale follows rectangle size only.
- A classic-mask point is used as a tracking point; it is not asserted to be the mask's center or size.

## Validation status

Five controlled Premiere 26.3.2 projects cover static, horizontal-only, vertical-only, scale-up, and scale-down behavior. Each decodes 20 frames. The controls validate independent center axes and increasing/decreasing bounds; the scale samples also contain some horizontal center drift. A separate 96-frame project and a 393-frame trimmed clip pass the PRMF reader. Premiere key readback confirmed 20 Position and 40 Scale keys on a scale-down graphic; scale-up behavior was also confirmed.

Object Mask Stabilize uses Motion Position in the current implementation, but its live write-and-render behavior has not been recorded as validated. Other pending checks include manual Effect Controls inspection and project close/reopen persistence.

## Development

The project uses CEP, HTML, JavaScript, and ExtendScript. Install the folder under:

    %APPDATA%\Adobe\CEP\extensions\com.objecttracker.premiere

Then reopen Window > Extensions > Object Tracker in Premiere. Unsigned local CEP builds may require CEP developer mode.

For implementation details see [implementation status](docs/implementation-status.md), [PRMF v3 findings](docs/object-mask-prmf-v3-findings.md), and the [historical reference panel analysis](docs/reference-tracker-analysis.md).
