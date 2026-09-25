# Premiere Object Mask PRMF v3 findings

## Current result

The Object Mask reader decodes per-frame rectangle and time records from PRMF v3 sidecars and returns normalized center, width, and height to the existing tracking pipeline. Detection follows each Tracker parameter's UUID references and validates the linked PRMF contents; it does not depend on Premiere's changing private-data hash. Five Premiere 26.3.2 control projects in `C:\controls` pass static, horizontal, vertical, scale-up, and scale-down checks. The 96-frame clip and the previously failing `my footage.mp4` clip also pass. The latter has 395 records, including one timestamp/payload-order outlier; its saved clip is trimmed to 393 frames. The reader sorts by the recorded times, maps them to the source-frame grid, and ignores records outside the trim. Premiere verified 20 Position keys and 40 Scale keys on the scale-down graphic; the scale-up behavior was also confirmed. Auto Scale is available only when per-frame bounds validate. Rotation remains unavailable.

The frame-data blocks themselves remain high-entropy and no tested standard codec decoded them. That layer is not required for the requested `frame`, `time`, `centerX`, `centerY`, `width`, and `height` output because the trailer already stores candidate rectangle fields.

## Additional Object Mask identifier

The saved `Test Edit_1.prproj` has two useful Object Mask examples. TrackItem `1000644` (`EPIC finish at Daytona 🤯.mp4`) yields 96 frames from its linked sidecars. TrackItem `1000297` (`my footage.mp4`) yields 393 frames after aligning its 395 timestamped records to the selected clip's saved frame range. That stream has one record whose timestamp is out of payload order, so times must be read from each record rather than inferred from payload order. Both examples use linked PRMF data; their private-data hashes differ and are not used to select the decoder. Single-record sidecars are retained as references and excluded from the motion timeline.

## Observed PRMF v3 layout

For the three UUID-resolved sidecars, the 32-byte header is consistent with:

| Offset | Type | Current interpretation | Evidence |
|---:|---|---|---|
| 0 | 4 bytes | `prmf` | All three files |
| 4 | u32 LE | version 3 | All three files |
| 8 | u32 LE | absolute end offset of frame payload | Equals trailer start |
| 12 | u32 LE | zero in these files | Observed only |
| 16 | u64 LE | trailer byte length | `payloadEnd + value == file size` |
| 24 | u64 LE | payload start, 32 | All three files |

This replaces the earlier, incorrect interpretation of offsets 16 and 24 as a leading u32 directory. The u32-like values from byte 32 to `payloadEnd` are frame-payload bytes. The trailer begins at `payloadEnd` and extends to EOF.

Each trailer root points to a frame vector. The observed frame table uses:

| Table location | Observed type/shape | Candidate meaning |
|---:|---|---|
| +4 | u32, value 1 | Unknown record flag/version |
| +8 | 16-byte inline struct: four u32 values | `x, y, width, height` |
| +24 | 8-byte inline struct: two u32 values | source width and height |
| +32 | u32 | frame payload byte count |
| +36 | u64 or absent | Premiere time ticks when present; if absent, this slot is omitted |
| +44 | u64, timed records only | absolute file offset of frame payload; untimed records store this at +36 |

The record layout has two observed shapes. Timestamped records have vtable offsets `(4,36,44,8,24,0,32)`; their timestamp is at table+36 and payload offset at table+44. The timestamp-omitted shape has `(4,0,36,8,24,0,32)`; it has no time field and payload offset at table+36. In both forms the geometry is four u32 values at table+8, dimensions are two u32 values at table+24, and payload length is at table+32. In the controlled 20-frame streams, stored timestamps map frames 1–19 to the saved clip grid; that agreement permits the missing first time to be assigned to frame 0. A single untimed one-record sidecar is retained as a reference candidate and excluded from the timeline.

The trailer uses signed vtable displacements, including shared vtables located after a table. The CEP JavaScript decoder validates the two registered record shapes and payload coverage, uses stored timestamps to order frames, and checks time-grid alignment, continuous clip coverage, stable source dimensions, and duplicate-geometry conflicts. Payload offsets validate the binary payload but do not always define the visible frame order.

## Referenced sidecar measurements

| UUID filename | File bytes | Payload bytes | Trailer bytes | Records |
|---|---:|---:|---:|---:|
| `70712641-7a83-463c-b458-530cadec7391.prmf` | 1,136 | 968 | 136 | 1 |
| `5216a87d-f3e6-4f39-9f6d-b6b11e34cd99.prmf` | 19,976 | 19,592 | 352 | 4 |
| `eca45d22-a0db-4b18-8f76-9c5adaaf0440.prmf` | 224,112 | 218,216 | 5,864 | 96 |

Every record's payload range is absolute in the file. The 1-record payload is `[32, 1000)`. The 4-record payload ranges are `[32,4540)`, `[4540,9384)`, `[9384,14316)`, and `[14316,19624)`. Across all three files, records within each sidecar are contiguous and exactly cover `[32,payloadEnd)` with no gaps or overlaps.

As a held-out parser check, the 234,396-byte sidecar `2049dad2-8076-40c1-981e-d7e4ab7e6a1e.prmf` from the 2026-09-25 14:16:47 Auto-Save Object Mask references decoded as 98 records in the same layout. Its 98 timestamps all align with the current three-file union. Eighty-nine rectangles match exactly; the other nine differ by at most 5 pixels per coordinate (mean absolute coordinate difference 0.069 px). The saves are uncontrolled, so this is evidence that the parser generalizes to another sidecar, not evidence of which edit caused the small rectangle changes.

All records report dimensions 608×1080, matching the source video stream and TrackItem `FrameRect`. Each file's timestamps increase at exactly 8,489,544,941 ticks, the saved source `MediaFrameRate`. The earliest time is 288,644,527,994 ticks, the source clip's `InPoint`.

The three sidecars have 98 unique timestamps after overlap. The clip's in/out interval is 831,975,404,218 ticks, exactly 98 frame durations. Every expected time from InPoint through the last in-interval frame is present. Three timestamps are duplicated between files: frame 0 agrees exactly; frames 94 and 95 overlap between the 96-record and 4-record sidecars, with frame 94 agreeing exactly and frame 95 differing by a few pixels.

The canonical merge now represents these as 101 source records → 98 unique timestamps: two exact duplicate records are collapsed, and one duplicate time is resolved with the coordinate-wise median. Its maximum per-coordinate disagreement is 2 px under the default 5 px tolerance; no large conflicts remain. Every output frame keeps all source UUIDs and source file/frame provenance. A disagreement over the configured tolerance, or source-dimension mismatch, leaves the chosen rectangle unset and flags a conflict. Canonical geometry includes `left`, `top`, `right`, `bottom`, center, size, and normalized center/size values derived from the 608×1080 source dimensions.

## Rectangle check against source footage

The candidate boxes were overlaid on the linked source video at:

| Frame | Source time | Candidate rectangle `(x,y,w,h)` | Visual result |
|---:|---:|---|---|
| 0 | 1.136324 s | `(312,517,94,48)` | Encloses the tracked black/yellow car |
| 48 | 2.740547 s | `(176,466,128,91)` | Encloses the same tracked car |
| 97 | 4.378190 s | `(81,319,225,215)` | Encloses the car as it approaches |

Across those frames, the box center moves from `(359,541)` to `(193.5,426.5)` and dimensions grow from 94×48 to 225×215. This checks candidate geometry against footage, but the clip changes horizontal position, vertical position, and apparent size together. It does not replace isolated controlled tests.

## Payload codec checks

The exact 1-, 4-, and 96-frame payload chunks were tested at their trailer-provided boundaries for zlib, gzip, raw DEFLATE, Brotli, Zstandard standard/magicless, LZ4 frame/raw block, Snappy raw, and LZFSE. No exact chunk decoded as any of those formats. The 96-frame chunks have entropy from 7.12752 to 7.87745 bits/byte (mean 7.53787); the 4-frame chunks average 7.87432 bits/byte. Signature scans also found no validated standard streams.

An all-byte-offset raw-DEFLATE sweep found 176 small parseable streams in the 218,216-byte payload, while a deterministic random byte array of the same length produced 147. The 19,592-byte payload produced 13 versus 14 random-baseline hits; the 968-byte payload produced zero versus one. The similar counts, with small outputs, show these are random-data false positives rather than evidence of embedded DEFLATE. The exact-chunk sweep found zero raw-DEFLATE streams.

The unknown high-entropy per-frame codec is therefore a remaining mask-raster investigation only. It does not block candidate bounding boxes already stored in the trailer.

## Reproduce

Inspect the header and candidate geometry for all three current references, with a project timing check:

```powershell
python tools\object_mask_forensics.py prmf-header "D:\Video Edit\editor interviews\Test Edit_1 Masks\eca45d22-a0db-4b18-8f76-9c5adaaf0440.prmf"

python tools\object_mask_forensics.py candidate-geometry `
  "D:\Video Edit\editor interviews\Test Edit_1 Masks\70712641-7a83-463c-b458-530cadec7391.prmf" `
  "D:\Video Edit\editor interviews\Test Edit_1 Masks\5216a87d-f3e6-4f39-9f6d-b6b11e34cd99.prmf" `
  "D:\Video Edit\editor interviews\Test Edit_1 Masks\eca45d22-a0db-4b18-8f76-9c5adaaf0440.prmf" `
  --project "D:\Video Edit\editor interviews\Test Edit_1.prproj" --track-item-id 1000630

python tools\object_mask_forensics.py candidate-geometry `
  "D:\Video Edit\editor interviews\Test Edit_1 Masks\70712641-7a83-463c-b458-530cadec7391.prmf" `
  "D:\Video Edit\editor interviews\Test Edit_1 Masks\5216a87d-f3e6-4f39-9f6d-b6b11e34cd99.prmf" `
  "D:\Video Edit\editor interviews\Test Edit_1 Masks\eca45d22-a0db-4b18-8f76-9c5adaaf0440.prmf" `
  "D:\Video Edit\editor interviews\Adobe Premiere Pro Auto-Save\Test Edit_1--06fc48fd-96c8-f095-4ddf-c57d0c90d28a-2026-09-25_14-16-47 Masks\2049dad2-8076-40c1-981e-d7e4ab7e6a1e.prmf" `
  --project "D:\Video Edit\editor interviews\Test Edit_1.prproj" --track-item-id 1000630

python tools\object_mask_forensics.py codec-scan "D:\Video Edit\editor interviews\Test Edit_1 Masks\eca45d22-a0db-4b18-8f76-9c5adaaf0440.prmf" --stride 128
```

`candidate-geometry` remains a forensic report command and intentionally labels its output `candidateFrames`; the application decoder is a separate implementation. With project and TrackItem arguments it resolves Tracker UUID references and rejects any omitted referenced sidecar. It reports each sidecar, canonical timeline, provenance, duplicate policy, conflicts, source dimensions, and expected timeline coverage.

## Controlled behavior report

`validate-controls` compares static, horizontal-only, vertical-only, scale-up, and scale-down samples to machine-readable expectations. Put the five one-variable control projects in a JSON manifest and list the corresponding TrackItem IDs. The manifest directory becomes the base for relative project and sidecar paths. Sidecars can be omitted when a saved project is supplied: the tool resolves the selected TrackItem's Tracker UUIDs and loads each matching `.prmf`. If `files` is supplied, its UUID stems must include every project reference. Project timing is checked against the source InPoint, MediaFrameRate, and tracked duration.

```json
{
  "conflictTolerancePx": 5,
  "thresholds": {
    "staticCenterTolerancePx": 3,
    "staticSizeTolerancePx": 3,
    "stationaryAxisTolerancePx": 3,
    "stationarySizeTolerancePx": 3,
    "minimumMotionPx": 10,
    "minimumScaleChangeRatio": 1.1,
    "scaleMonotonicFraction": 0.8
  },
  "samples": [
    { "name": "static", "behavior": "static", "project": "controls/static.prproj", "trackItemId": "1000630" },
    { "name": "horizontal", "behavior": "horizontal", "project": "controls/horizontal.prproj", "trackItemId": "1000630" },
    { "name": "vertical", "behavior": "vertical", "project": "controls/vertical.prproj", "trackItemId": "1000630" },
    { "name": "scale-up", "behavior": "scale-up", "project": "controls/scale-up.prproj", "trackItemId": "1000630" },
    { "name": "scale-down", "behavior": "scale-down", "project": "controls/scale-down.prproj", "trackItemId": "1000630" }
  ]
}
```

The supplied manifest is `C:\controls\object-mask-control-manifest.json`; its output is `C:\controls\object-mask-control-report.json`. Re-run it with:

```powershell
python tools\object_mask_forensics.py validate-controls C:\controls\object-mask-control-manifest.json > C:\controls\object-mask-control-report.json
```

All five samples pass with 20 frames and 608×1080 source geometry. Static center/size ranges are within 0.5/2 px. Horizontal movement changes X by 47 px net while Y changes 0.5 px; vertical movement changes Y by −88.5 px net while X is constant. Scale-up changes width/height by ratios 1.386/1.391 and scale-down by 0.574/0.570; both dimensions are monotonic in every step. The scale samples also show center drift (scale-up: +33.5 px X; scale-down: −53.5 px X), so report that diagnostic instead of describing the samples as perfectly isolated size-only controls.

The JavaScript project reader was run over the same five projects. It resolves the two actual `.prmf` files among the serialized UUID tokens, keeps each untimed singleton reference separate, maps 20 temporal rows to saved source frame times, and emits `centerX`, `centerY`, `width`, `height`, and normalized center coordinates. The actual solver was also exercised on the scale-up/down tracks: it returns a factor above 1 for growth, below 1 for shrinkage, and 1 at the reference frame, multiplying the existing target Scale baseline. The classic-mask 121-point extraction remains unchanged. Rotation is not enabled.

The one-frame → two-frame → three-frame Premiere save progression is not present in `C:\controls`, so repeatable file growth, append-vs-rewrite behavior, and chunk creation are still unknown. This does not block geometry output because the trailer exposes the needed rectangle and timing fields directly; the unidentified high-entropy payload codec is needed only for raster/contour recovery. The new application path is experimental for Premiere 26.x and has not yet had a live Premiere Transform Position/Scale write-and-readback run. The forensic validator reports `liveTransformReadbackVerified: false` for that reason.
