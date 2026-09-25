# Implementation status

Development target: Adobe Premiere Pro 26.3.2, CEP 12. This page describes the current workspace code and distinguishes it from host validation.

## Current behavior

### Read a track

Read Track Source saves the open Premiere project, then reads the saved project XML and the adjacent Masks folder. The reader resolves the selected timeline video's project ID, follows its own mask component links to the nested Tracker parameter, resolves that parameter's UUID references, and reads only those sidecars.

The decoder identifies Object Mask data when the linked sidecars pass the registered PRMF v3 checks. Premiere's changing private component hash is not used to identify Object Masks. A known classic-mask hash can identify the legacy point-stream case; an unknown hash by itself is not treated as a decoder match.

### Decoders

- Object Mask, Premiere 26.x: reads rectangle coordinates, source dimensions, payload ranges, and stored times from PRMF v3 trailer records. Each temporal payload is a GDeflate-compressed 8-bit outline raster. The panel decodes it, checks its byte count and dimensions, confirms its outline bounds are within 2 pixels of the saved rectangle, then measures the pixel bounds and row-span centroid. It aligns records with saved source-frame timing, handles the observed timestamp-omitted record shape when another sidecar establishes one stable payload offset, sorts by recorded time, and ignores frames outside the selected clip's trim. Single-record sidecars remain references instead of motion samples.
- Classic AEMask2, Premiere 26.x: reads the observed 104-byte Tracker entries and extracts XY float32 values at offsets 64 and 68. An uninitialized first identity sample is omitted. The resulting point track provides Position motion only; it does not provide validated bounds.
- Premiere 27.x: both private layouts are disabled until separately validated.

Object Mask frames are reported only after the linked sidecars, registered record layout, GDeflate decoding, raster dimensions, outline-to-rectangle check, source dimensions, source-frame timing, overlap, and frame continuity pass validation. The decoder allows at most one missing frame at either clip boundary and rejects interior gaps, unresolved bounds or centroid conflicts, and changing source dimensions.

### Panel workflow and apply motion

The current panel has three source/target actions: **Detect**, **Use Selection**, and **Apply Tracking**. Detect saves the project and reads the selected source clip. Use Selection records exactly one currently selected timeline video clip or graphic as the target. Apply rechecks that the same clip is still selected before writing. The panel does not currently expose a Clear Generated Keys button.

| Action | Current implementation |
|---|---|
| Follow | Uses Transform Position. Keeps the selected target's existing Position as the baseline and applies the tracked center delta from the first overlapping frame. |
| Follow with Auto Scale | Requires validated Object Mask bounds. Scales each target axis from its existing Scale baseline by sqrt((current width / reference width) × (current height / reference height)). Scale-up grows the target; scale-down shrinks it. |
| Follow with Motion Blur | Sets the existing target Transform effect's native Shutter Angle to at least 180°. If **Use Composition's Shutter Angle** is on, it turns that override off and reads both values back. |
| Stabilize | Uses the selected target's built-in Motion Position and writes inverse movement. It does not add Transform, animate Scale, or copy the source Object Mask to the target. |
| Clear generated keys | A guarded host-side `clearGeneratedPositionKeys` routine exists in JSX, but the panel does not call it, retain the generated-key record, or expose a clear action. Treat clearing as unavailable from the current UI; remove keys through Premiere's Effect Controls. |

The X and Y controls select which Position axes to move, and at least one must be selected. Auto Scale is only available in Follow mode when the cached track has validated bounds. Motion Blur is available in Follow mode only and sets Transform's native Shutter Angle; it does not animate blur strength from movement. The former Fit target frame control was removed. A detected track is cached in panel local storage and can be restored when the panel is reopened; generated-key records are not currently retained by the UI.

### Coordinate and target behavior

Position deltas use source-frame width and height, then convert against sequence dimensions when the target Position uses normalized values. Source Motion Scale, source rotation, pixel aspect ratio, and nested sequence transforms are not applied.

Follow moves the target clip as a whole. It does not measure visible artwork bounds, PNG transparency, internal crop, or graphic anchor to fit the artwork to the mask. The user places and sizes a highlight or label at its intended starting frame. Auto Scale follows the object's size ratio; it is not a pixel-to-pixel fit operation. Classic point streams cannot enable it.

## Validation evidence

### Parser and solver

The controlled manifest at C:\controls\object-mask-control-manifest.json contains five Premiere 26.3.2 projects: static, horizontal, vertical, scale-up, and scale-down. The static/horizontal/vertical projects use TrackItem 71; scale-up/down use TrackItem 77. Each stream decodes 20 frames at 608×1080.

The independent JavaScript decoder produced the same SHA-256 output bytes as a separate GDeflate reference decoder for all 100 temporal rasters in these five controls. Overlay checks on static, horizontal, and scale-up/down frames place the decoded raster outline on the visible cat boundary.

The mask-derived geometry passes these checks:

- Static outline centroid varies by about 0.13 px in X and 0.06 px in Y; width is unchanged and height varies by 2 px.
- Horizontal motion changes X by 46.9 px net while Y changes 0.5 px.
- Vertical motion changes Y by -87.5 px while X changes 0.1 px.
- Scale-up changes outline width and height by factors of 1.386 and 1.389.
- Scale-down changes outline width and height by factors of 0.574 and 0.571.
- Scale-up and scale-down also contain horizontal center drift, so they are not perfect size-only image sequences.

The 325-frame face mask in `D:\Video Edit\editor interviews\Test Edit_1.prproj` also decodes from its linked sidecars at 1920×1080. Its raster bytes match the independent GDeflate reference for all 325 frames, and source-video overlays show the recovered outline following the face. The saved clip expects 326 frames, so the final frame is missing; the reader reports 325 frames and allows one missing frame at the trailing edge. Earlier 96-frame and trimmed-project checks validated the rectangle-only parser; those files have not been rerun through the raster decoder.

### Premiere host

Premiere verified Transform key writing with the earlier rectangle-center reader: 20 Position keys and 40 Scale keys on a scale-down graphic; scale-up behavior was also confirmed. The classic-mask path has separate history: 121 Transform Position keys were read back, 118 Follow keys were read back on a MOGRT, and inverse Position keys were visually checked on a disposable video overlay. The new raster-centroid Position output still needs a live Premiere apply check.

The current JSX implements Object Mask Stabilize through Motion Position only. A live Object Mask Stabilize write/readback and rendered comparison are not recorded here. Manual Effect Controls inspection and project close/reopen persistence checks are also outstanding.

The Motion Blur option and host writer now set Transform's native Shutter Angle to at least 180°, turn off **Use Composition's Shutter Angle** when necessary, and read the setting back. This change has not yet been exercised in a live Premiere session. Confirm the effect controls and rendered result in Premiere before treating it as host-validated.

## Safeguards

- Refuses ambiguous Transform or Position matches, unreadable key state, existing Position animation, a source clip selected as its own Follow target, and insufficient time overlap.
- Adds Transform through QE only for Follow when needed, then verifies the component before writing.
- Auto Scale requires positive, readable, unanimated Transform Scale values and unique Scale properties.
- Reads each generated key back. Write failures trigger rollback attempts.
- The JSX clear routine checks recorded time and value before removing keys, but it is not currently wired to the panel and cannot be used through the shipped UI.

## Reproduce the checks

Run the JavaScript reader and solver checks:

    node tests\object-mask-controls.test.js C:\controls

Check a saved Premiere Object Mask project:

    node tests\project-reader-sample.js "D:\Video Edit\editor interviews\Test Edit_1.prproj" 1000294 26.3.2 --expect-object-mask

Run the tracking pipeline checks:

    node tests\tracking-pipeline.test.js

The Python tool emits candidate geometry from PRMF trailer rectangles for forensic comparison. It does not decode GDeflate. The CEP reader is the application decoder and now uses the decoded raster outline. See [PRMF v3 findings](object-mask-prmf-v3-findings.md) for the record layout, codec, and control evidence.
