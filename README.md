# Object Tracker

Object Tracker is an Adobe Premiere Pro CEP panel for reading a mask track from a saved Premiere project and writing editable motion keyframes to another timeline clip. The current parser and tracking data are validated for Premiere Pro 26.x.

## Use the panel

1. Open a sequence and select one video timeline clip that contains a tracked Object Mask or supported classic mask. Linked audio may stay selected, but select only one video clip.
2. Click **Detect**. The panel saves the project, then reads the selected clip's tracking data from the project file and its adjacent `Masks` folder. The project must already have a file path; save a new project first. Wait for the detected source name and frame count.
3. Select the video or graphic clip that should receive the motion, then click **Use Selection**. The selected target must be in the same sequence as the source.
4. Choose **Follow** or **Stabilize** and choose the X and Y axes. In Follow mode, **Scale** becomes available only when the detected Object Mask has validated per-frame size data. You can also enable **Motion Blur** to set the target Transform effect's native Shutter Angle to at least 180°.
5. Click **Apply Tracking**. Keep the chosen target selected until the operation completes. Save the Premiere project to keep the new keyframes.

The panel rechecks that the same target is selected before writing. If Premiere cannot safely identify a unique Position property, the target already has Position animation, or the track and target do not overlap in time, the panel stops and reports the issue. For a new target, place and size it where it should appear on the first tracked frame before applying Follow.

## Tracking modes

| Mode | Result |
|---|---|
| Follow | Writes Transform Position keys using the tracked center's movement from the first overlapping frame. The target's existing Transform Position is the placement baseline. |
| Follow with Scale | Also writes Transform Scale keys from validated Object Mask width and height changes. The target's starting Scale is the reference. The scale factor is the square root of the product of the width ratio and height ratio. |
| Follow with Motion Blur | Sets the target Transform effect's native Shutter Angle to at least 180°. If **Use Composition's Shutter Angle** is enabled, the panel turns it off so the Transform value takes effect. |
| Stabilize | Writes inverse movement to the target's built-in Motion Position. It does not add Transform, change Scale, or copy the mask to the target. Scale is disabled. |

X and Y independently control the Position axes. At least one axis must be selected. Object Mask Position uses the decoded outline's row-span centroid, and Scale follows the outline bounds. It does not fit visible graphic pixels, transparent image edges, crop, or anchor points to the mask.

## Supported source data

- **Object Mask, Premiere 26.x:** The reader follows the selected tracker's UUID sidecar references, decodes each temporal PRMF v3 frame raster from GDeflate, and measures bounds and an outline centroid. It checks record layout, payload ranges, raster dimensions, source dimensions, clip timing, overlap, raster-to-rectangle agreement, and frame coverage before reporting geometry or enabling Scale.
- **Classic AEMask2, Premiere 26.x:** The reader extracts the observed 104-byte tracker point samples for Position. These samples do not provide validated bounds, so Scale is unavailable.
- **Premiere 27.x:** Private data parsing is disabled until those formats have been independently validated. Rotation is not decoded.

The mask source must be accessible through the saved project and its adjacent `Masks` folder. Detect reads the selected clip's own mask component and linked data. Object Mask recognition is based on validated sidecars rather than a private component hash. One-record sidecars are treated as references, not motion samples.

## Current limits

- Follow moves and scales the target clip as a whole. It does not inspect a graphic's visible artwork, PNG transparency, internal crop, or anchor point. Place the target correctly on its first tracked frame.
- Position conversion uses source and sequence frame dimensions. Source Motion Scale, rotation, pixel aspect ratio, and nested-sequence transforms are not applied and can affect alignment.
- Object Mask rotation and perspective are unsupported. Its raster stores an outline rather than a filled mask, so the panel estimates the centroid by filling each row between the first and last outline pixels; bounds come from the outline pixels.
- Motion Blur sets one static Transform Shutter Angle value; it does not animate the angle from movement and is available only in Follow mode. Premiere must expose the Transform Shutter Angle control. The writer reads the value back and rolls back tracking keys if Premiere rejects the setting.
- The native Shutter Angle write has not yet been checked in a live Premiere session. Confirm the Transform control and rendered result in Premiere before relying on it.
- A classic-mask sample is treated as a tracker point; the plugin does not assert that it is the mask center or size.
- The panel currently has no user-facing **Clear Generated Keys** control. Premiere keyframe writing is available through the panel, while the host-side clear routine is not connected to the UI. To remove keys, edit them in Premiere's Effect Controls.
- Object Mask Stabilize is implemented through Motion Position, but its live write and rendered result have not been recorded as validated. Manual Effect Controls inspection and project reopen persistence checks are also outstanding.

## Install for development

This CEP extension targets Adobe Premiere Pro 26+ and CEP 12. Copy the project folder to:

    %APPDATA%\Adobe\CEP\extensions\com.objecttracker.premiere

Then reopen **Window > Extensions > Object Tracker** in Premiere. Unsigned local CEP builds may require CEP developer mode. The extension currently declares Premiere versions 26.0 and later in its manifest, but the private data readers are only enabled for validated Premiere 26.x formats.

For implementation and validation details, see [implementation status](docs/implementation-status.md), [PRMF v3 findings](docs/object-mask-prmf-v3-findings.md), and [historical reference panel analysis](docs/reference-tracker-analysis.md).
