# Premiere Object Mask PRMF v3 findings

## Current result

The application decoder follows the selected Tracker parameter's UUID sidecar references, reads per-frame rectangles and times from each PRMF v3 trailer, and decodes every temporal frame payload as a GDeflate-compressed 8-bit outline raster. It checks that the decompressed byte count equals rectangle width × height and that the raster outline stays within 2 pixels of the saved rectangle. Position uses a centroid estimated by filling each raster row between its first and last nonzero pixel; size uses the nonzero outline bounds. Object Mask detection does not depend on Premiere's changing private component hash.

Five controlled Premiere 26.3.2 projects pass static, horizontal, vertical, scale-up, and scale-down geometry checks. Each has 20 tracked frames at 608×1080. The 325-frame face mask in `D:\Video Edit\editor interviews\Test Edit_1.prproj` also passes the raster decoder at 1920×1080; its bytes match the independent reference for all 325 frames, and source-video overlays align with the face outline. The project expects 326 frames, so one trailing frame is missing. An earlier 96-frame clip and trimmed 395-record project passed the old rectangle-only reader; they have not yet been rerun through this raster decoder. Times are read from each record and matched to the saved source-frame grid, not inferred from vector order alone.

The GDeflate decoder was checked against five controlled Premiere 26.3.2 projects. A separate GDeflate reference decoder produced matching SHA-256 hashes for all 100 decoded frame rasters. Visual overlays on the source video show the recovered outline following the visible object. Premiere's earlier Position and Scale key-write checks remain separate from this raster validation.

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

The trailer rectangle dimensions describe each raster payload. The reader also checks registered trailer and vtable shapes, in-file pointers, positive rectangle dimensions, rectangle bounds, and that frame payload ranges are contiguous and exactly cover the payload region. After decompression, it derives bounds and centroid from the outline pixels, rather than using the trailer rectangle's center.

Stored times are matched to the selected source clip's saved InPoint and MediaFrameRate. The observed timestamp-free records can be assigned to the source grid only when timestamped records establish one stable payload-to-frame offset. Records are ordered by their times. The reader excludes single-record sidecars from temporal motion, crops records to the selected clip's trim, merges duplicate timestamps only when their rectangle disagreement is within tolerance, requires stable source dimensions, and rejects interior gaps or unresolved conflicts. At most one missing frame at either clip boundary is tolerated.

## Controlled geometry results

The control manifest is C:\controls\object-mask-control-manifest.json. All five samples pass with 20 frames:

| Sample | Geometry result |
|---|---|
| Static | Outline centroid changes by 0.12 px in X and 0.06 px in Y; width is unchanged; height varies by 2 px. |
| Horizontal | X changes 46.9 px net while Y changes 0.5 px. |
| Vertical | Y changes -87.5 px net while X changes 0.1 px. |
| Scale-up | Outline width and height increase by ratios 1.386 and 1.389. |
| Scale-down | Outline width and height decrease by ratios 0.574 and 0.571. |

Scale samples also show X center drift of +33.5 px during scale-up and -53.5 px during scale-down. The supplied scale controls therefore verify monotonic size change but are not perfectly isolated visual scale experiments.

The reader and solver checks confirm that horizontal and vertical movement affect the expected centroid axes and that scale factors grow above 1 and shrink below 1 relative to the first overlapping frame. Visual overlays on static, horizontal, scale-up, and scale-down clips confirm that the decoded pixels trace the object. The classic-mask 121-point sample remains a separate point-only stream.

## Historical 98-frame forensic corpus

The following file sizes and UUIDs come from an older saved project whose TrackItem 1000630 is no longer a current fixture. Keep these measurements as historical format evidence; use C:\controls for current controlled checks.

| UUID sidecar | File bytes | Payload bytes | Trailer bytes | Records |
|---|---:|---:|---:|---:|
| 70712641-7a83-463c-b458-530cadec7391.prmf | 1,136 | 968 | 136 | 1 |
| 5216a87d-f3e6-4f39-9f6d-b6b11e34cd99.prmf | 19,976 | 19,592 | 352 | 4 |
| eca45d22-a0db-4b18-8f76-9c5adaaf0440.prmf | 224,112 | 218,216 | 5,864 | 96 |

The three historical sidecars held 101 source records and merged to 98 unique timestamps. Their frame payload ranges were contiguous and covered the declared payload region. A held-out 234,396-byte sidecar from an uncontrolled Auto-Save parsed as 98 records on the same layout. Eighty-nine rectangles matched the earlier union exactly; the remaining nine differed by no more than 5 px in any coordinate. This supports parser reuse across that save but does not prove which edit caused the differences.

The historical source was 608×1080. The merged timeline matched its 98-frame interval. A visual check against the source video showed boxes around the tracked car at the inspected frames; movement, size, and position all changed together, so those frames were not used as isolated behavior controls.

## GDeflate mask payload

The payload is GDeflate, a DEFLATE-based format arranged for 32 parallel bit lanes. Its frame wrapper does not use the usual gzip or zlib signature. In the observed blocks:

| Offset | Meaning supported by the samples |
|---:|---|
| 0 | codec id `4` |
| 1 | id complement `0xFB` |
| 2 | tile count, u16 LE |
| 4 | packed final-tile uncompressed byte count |
| 8 | tile-offset table; first entry is the final tile's compressed length, later entries are tile starts |
| after the table | compressed tile data |

Each tile produces up to 65,536 bytes. The application decodes the GDeflate lanes directly in JavaScript. Each Object Mask frame decompresses to exactly `raster width × raster height` bytes. The grayscale data is an outline of the object, not a filled bitmap. The recovered outline was overlaid on the source video and follows the visible object.

The plugin measures bounds from all nonzero outline pixels. It estimates the silhouette centroid by filling each row from its first through its last nonzero pixel and averaging those row spans. This produces stable movement and size values in the current controls, but it does not recover Adobe's exact polygon or filled selection.

The JavaScript decompressor's output was compared by SHA-256 with a separate GDeflate reference decoder for all 100 temporal rasters in the five controlled projects and all 325 temporal rasters in the real face-mask project. Decoding fails closed if the codec, tile offsets, expected raster byte count, or outline-to-rectangle check fails.

## Reproduce

Read the current static control's PRMF header and inspect its two linked sidecars:

    python tools\object_mask_forensics.py prmf-header "C:\controls\static\Static Masks\63c7b76f-c97e-4ddc-95f4-9ac3aebdcc75.prmf"

    python tools\object_mask_forensics.py candidate-geometry "C:\controls\static\Static Masks\1185ad76-c97e-4ddc-95f4-9ac3aebdcc75.prmf" "C:\controls\static\Static Masks\63c7b76f-4e94-43b2-894c-e928b20255ff.prmf" --project "C:\controls\static\Static.prproj" --track-item-id 71

Run the five-project application reader/solver checks:

    node tests\object-mask-controls.test.js C:\controls
    node tests\project-reader-sample.js "D:\Video Edit\editor interviews\Test Edit_1.prproj" 1000294 26.3.2 --expect-object-mask

The forensic candidate-geometry command reports trailer rectangles and timing evidence; it does not decode GDeflate. The JavaScript application decoder checks GDeflate rasters before enabling Object Mask frames or Auto Scale.

## Remaining limits

The 1-frame to 2-frame to 3-frame save progression has not been performed, so repeatable file growth and append-versus-rewrite behavior are unknown. Rotation and the exact polygon representation are not decoded. The centroid is a row-span estimate of the outline. Validate a different Premiere version or raster shape against new controlled samples before enabling its parser.

Object Mask rotation is not decoded. Object Mask Stabilize is implemented through Motion Position only, but a live write/readback and rendered comparison for that specific combination are not recorded as validated. See [implementation status](implementation-status.md) for the other current host-check gaps.
