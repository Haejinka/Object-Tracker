# Implementation status

Development target: Adobe Premiere Pro 26.3.2, CEP 12. This page describes the current workspace code and distinguishes it from host validation.

## Current behavior

### Read a track

Read Track Source saves the open Premiere project, then reads the saved project XML and the adjacent Masks folder. The reader resolves the selected timeline video's project ID, follows its own mask component links to the nested Tracker parameter, resolves that parameter's UUID references, and reads only those sidecars.

The decoder identifies Object Mask data when the linked sidecars pass the registered PRMF v3 checks. Premiere's changing private component hash is not used to identify Object Masks. A known classic-mask hash can identify the legacy point-stream case; an unknown hash by itself is not treated as a decoder match.

### Decoders

- Object Mask, Premiere 26.x: reads per-frame rectangle coordinates, source dimensions, payload ranges, and stored times from PRMF v3 trailer records. It aligns records with saved source-frame timing, handles the observed timestamp-omitted record shape when another sidecar establishes one stable payload offset, sorts by recorded time, and ignores frames outside the selected clip's trim. Single-record sidecars remain references instead of motion samples.
- Classic AEMask2, Premiere 26.x: reads the observed 104-byte Tracker entries and extracts XY float32 values at offsets 64 and 68. An uninitialized first identity sample is omitted. The resulting point track provides Position motion only; it does not provide validated bounds.
- Premiere 27.x: both private layouts are disabled until separately validated.

Object Mask frames are reported only after the linked sidecars, registered record layout, payload coverage, source dimensions, source-frame timing, overlap, and frame continuity pass validation. The decoder allows at most one missing frame at either clip boundary and rejects interior gaps, unresolved rectangle conflicts, and changing source dimensions.

### Apply motion

| Action | Current implementation |
|---|---|
| Follow | Uses Transform Position. Keeps the selected target's existing Position as the baseline and applies the tracked center delta from the first overlapping frame. |
| Follow with Auto Scale | Requires validated Object Mask bounds. Scales each target axis from its existing Scale baseline by sqrt((current width / reference width) × (current height / reference height)). Scale-up grows the target; scale-down shrinks it. |
| Stabilize | Uses the selected target's built-in Motion Position and writes inverse movement. It does not add Transform, animate Scale, or copy the source Object Mask to the target. |
| Clear | Removes recorded keys only when their timestamp and value still match. It restores the original static baseline when appropriate and preserves edited or unrelated keys. |

The X and Y controls select which Position axes to move. Auto Scale is only available in Follow mode when the cached track has validated bounds. The former Fit target frame control was removed.

### Coordinate and target behavior

Position deltas use source-frame width and height, then convert against sequence dimensions when the target Position uses normalized values. Source Motion Scale, source rotation, pixel aspect ratio, and nested sequence transforms are not applied.

Follow moves the target clip as a whole. It does not measure visible artwork bounds, PNG transparency, internal crop, or graphic anchor to fit the artwork to the mask. The user places and sizes a highlight or label at its intended starting frame. Auto Scale follows the object's size ratio; it is not a pixel-to-pixel fit operation. Classic point streams cannot enable it.

## Validation evidence

### Parser and solver

The controlled manifest at C:\controls\object-mask-control-manifest.json contains five Premiere 26.3.2 projects: static, horizontal, vertical, scale-up, and scale-down. The static/horizontal/vertical projects use TrackItem 71; scale-up/down use TrackItem 77. Each stream decodes 20 frames at 608×1080.

The controls pass the intended checks:

- Static center varies by at most 0.5 px; width is unchanged and height varies by 2 px.
- Horizontal motion changes X by 47 px net while Y changes 0.5 px.
- Vertical motion changes Y by -88.5 px while X stays constant.
- Scale-up changes width and height by factors of 1.386 and 1.391.
- Scale-down changes width and height by factors of 0.574 and 0.570.
- Scale-up and scale-down also contain horizontal center drift, so they are not perfect size-only image sequences.

A separate 96-frame Object Mask and a trimmed clip with 395 PRMF records pass the reader; the latter maps to 393 frames in the selected clip range despite one timestamp being out of payload order. An older 98-frame project is a held-out forensic check, not a current test fixture.

### Premiere host

Premiere verified 20 Transform Position keys and 40 Transform Scale keys on the scale-down graphic. Scale-up behavior was also confirmed. The classic-mask path has separate history: 121 Transform Position keys were read back, 118 Follow keys were read back on a MOGRT, and inverse Position keys were visually checked on a disposable video overlay.

The current JSX implements Object Mask Stabilize through Motion Position only. A live Object Mask Stabilize write/readback and rendered comparison are not recorded here. Manual Effect Controls inspection and project close/reopen persistence checks are also outstanding.

## Safeguards

- Refuses ambiguous Transform or Position matches, unreadable key state, existing Position animation, a source clip selected as its own Follow target, and insufficient time overlap.
- Adds Transform through QE only for Follow when needed, then verifies the component before writing.
- Auto Scale requires positive, readable, unanimated Transform Scale values and unique Scale properties.
- Reads each generated key back. Write failures trigger rollback attempts.
- Clear checks recorded time and value before removing keys.

## Reproduce the checks

Run the controlled geometry report:

    python tools\object_mask_forensics.py validate-controls C:\controls\object-mask-control-manifest.json

Run the JavaScript reader and solver checks:

    node tests\object-mask-controls.test.js C:\controls

Run the classic-mask project-reader regression:

    node tests\project-reader-sample.js

Run the tracking pipeline checks:

    node tests\tracking-pipeline.test.js

The Python tool emits candidate geometry for forensic reporting. The CEP reader is the application decoder; do not treat candidate geometry alone as validated plugin output. See [PRMF v3 findings](object-mask-prmf-v3-findings.md) for the record layout, control results, and codec investigation.
