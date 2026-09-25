# Premiere Object Mask PRMF v3 findings

## Current result

The application decoder reads per-frame rectangle and time records from PRMF v3 sidecars and supplies normalized center and size to Object Tracker. The reader follows UUID references in the selected clip's Tracker parameter and validates the referenced sidecar data; it does not identify Object Masks by a private component hash.

Five controlled Premiere 26.3.2 projects pass static, horizontal, vertical, scale-up, and scale-down geometry checks. Each has 20 tracked frames at 608×1080. A separate 96-frame clip and a trimmed clip with 395 timestamped records also pass the reader; the trimmed clip yields 393 in-range frames, including one timestamp that is out of payload order. Times therefore come from each record and are matched to the saved source-frame grid, not inferred from vector order alone.

Premiere verified 20 Transform Position keys and 40 Transform Scale keys on a scale-down graphic; scale-up behavior was also confirmed. The unknown frame-payload codec is still needed to recover mask rasters or contours, but not the rectangle output needed for tracking.

## Observed PRMF v3 layout

The observed 32-byte header has this shape:

| Offset | Type | Interpretation supported by samples |
|---:|---|---|
| 0 | 4 bytes | prmf signature |
| 4 | u32 LE | version, value 3 |
| 8 | u32 LE | absolute end offset of frame payload; also trailer start |
| 12 | u32 LE | reserved or unknown; zero in observed files |
| 16 | u64 LE | trailer byte length; payload end plus this value equals file size |
| 24 | u64 LE | payload start; value 32 in observed files |

The trailer root points to a frame vector. Each frame record uses one of two registered shapes:

| Table field | Timed record | Record without timestamp |
|---|---|---|
| Vtable field offsets | (4,36,44,8,24,0,32) | (4,0,36,8,24,0,32) |
| +8 | x, y, width, height as four u32 values | Same |
| +24 | source width and height as two u32 values | Same |
| +32 | payload byte count, u32 | Same |
| +36 | Premiere time ticks, u64 | omitted |
| +44 | absolute payload offset, u64 | absolute payload offset at +36 |

The rectangle fields are the values used by the decoder. Independent position and scale controls support that interpretation. The sidecar parser also checks registered trailer and vtable shapes, in-file pointers, positive rectangle dimensions, rectangle bounds, and that frame payload ranges are contiguous and exactly cover the payload region.

Stored times are matched to the selected source clip's saved InPoint and MediaFrameRate. The observed timestamp-free records can be assigned to the source grid only when timestamped records establish one stable payload-to-frame offset. Records are ordered by their times. The reader excludes single-record sidecars from temporal motion, crops records to the selected clip's trim, merges duplicate timestamps only when their rectangle disagreement is within tolerance, requires stable source dimensions, and rejects interior gaps or unresolved conflicts. At most one missing frame at either clip boundary is tolerated.

## Controlled geometry results

The control manifest is C:\controls\object-mask-control-manifest.json. All five samples pass with 20 frames:

| Sample | Geometry result |
|---|---|
| Static | Center varies by at most 0.5 px; width is unchanged; height varies by 2 px. |
| Horizontal | X changes 47 px net while Y changes 0.5 px. |
| Vertical | Y changes -88.5 px net while X stays constant. |
| Scale-up | Width and height increase by ratios 1.386 and 1.391. |
| Scale-down | Width and height decrease by ratios 0.574 and 0.570. |

Scale samples also show X center drift of +33.5 px during scale-up and -53.5 px during scale-down. The supplied scale controls therefore verify monotonic size change but are not perfectly isolated visual scale experiments.

The reader and solver checks confirm that horizontal and vertical movement affect the expected center axes and that scale factors grow above 1 and shrink below 1 relative to the first overlapping frame. The classic-mask 121-point sample remains a separate point-only stream.

## Historical 98-frame forensic corpus

The following file sizes and UUIDs come from an older saved project whose TrackItem 1000630 is no longer a current fixture. Keep these measurements as historical format evidence; use C:\controls for current controlled checks.

| UUID sidecar | File bytes | Payload bytes | Trailer bytes | Records |
|---|---:|---:|---:|---:|
| 70712641-7a83-463c-b458-530cadec7391.prmf | 1,136 | 968 | 136 | 1 |
| 5216a87d-f3e6-4f39-9f6d-b6b11e34cd99.prmf | 19,976 | 19,592 | 352 | 4 |
| eca45d22-a0db-4b18-8f76-9c5adaaf0440.prmf | 224,112 | 218,216 | 5,864 | 96 |

The three historical sidecars held 101 source records and merged to 98 unique timestamps. Their frame payload ranges were contiguous and covered the declared payload region. A held-out 234,396-byte sidecar from an uncontrolled Auto-Save parsed as 98 records on the same layout. Eighty-nine rectangles matched the earlier union exactly; the remaining nine differed by no more than 5 px in any coordinate. This supports parser reuse across that save but does not prove which edit caused the differences.

The historical source was 608×1080. The merged timeline matched its 98-frame interval. A visual check against the source video showed boxes around the tracked car at the inspected frames; movement, size, and position all changed together, so those frames were not used as isolated behavior controls.

## Payload codec investigation

The exact payload chunks were tested at their trailer-provided boundaries for zlib, gzip, raw DEFLATE, Brotli, Zstandard standard and magicless formats, LZ4 frame and raw block, Snappy raw, and LZFSE. None decoded as those formats. The 96-frame chunks had entropy between 7.12752 and 7.87745 bits per byte, with mean 7.53787; the historical 4-frame chunks averaged 7.87432.

An all-byte-offset raw-DEFLATE sweep found similar small parseable outputs in payloads and same-length deterministic-random baselines. Those results are false-positive parses, not evidence of embedded DEFLATE. The tested standard codec layer remains unidentified. It is not needed to read the rectangles and times currently used by the plugin.

## Reproduce

Read the current static control's PRMF header and inspect its two linked sidecars:

    python tools\object_mask_forensics.py prmf-header "C:\controls\static\Static Masks\63c7b76f-c97e-4ddc-95f4-9ac3aebdcc75.prmf"

    python tools\object_mask_forensics.py candidate-geometry "C:\controls\static\Static Masks\1185ad76-c97e-4ddc-95f4-9ac3aebdcc75.prmf" "C:\controls\static\Static Masks\63c7b76f-4e94-43b2-894c-e928b20255ff.prmf" --project "C:\controls\static\Static.prproj" --track-item-id 71

Run the five-project behavior report and application reader/solver checks:

    python tools\object_mask_forensics.py validate-controls C:\controls\object-mask-control-manifest.json
    node tests\object-mask-controls.test.js C:\controls

The forensic candidate-geometry command reports extracted metadata and timing evidence. Candidate output by itself is not the application's validated tracking result. The JavaScript decoder applies the host-version and registered-record checks before enabling Object Mask frames or Auto Scale.

## Remaining limits

The 1-frame to 2-frame to 3-frame save progression has not been performed, so repeatable file growth and append-versus-rewrite behavior are unknown. The high-entropy payload codec and mask raster remain undecoded. Neither blocks per-frame rectangle tracking.

Object Mask rotation is not decoded. Object Mask Stabilize is implemented through Motion Position only, but a live write/readback and rendered comparison for that specific combination are not recorded as validated. See [implementation status](implementation-status.md) for the other current host-check gaps.
