# Implementation status

Development target: Premiere Pro 26.3.2, CEP 12. The panel is still CEP-based and keeps project-file reading separate from Premiere's scripting object model.

## Verified behavior

- The CEP panel rendered and connected to the ExtendScript bridge.
- The runtime inspector enumerates selected TrackItems, components, properties, parameter values, runtime members, and exposed keyframe operations.
- The saved project reader resolves the selected `TrackItem.nodeId` to its decimal XML `<VideoClipTrackItem><ID>`, follows that item's `SelectionComponents` → `VideoComponentChain` → `VideoFilterComponent` links, then reads only that mask's nested `Tracker` parameter.
- The saved project sample links TrackItem `1000298` to `AE.ADBE AEMask2` component `1191`, nested instance `05` / component `2020`, and Tracker parameter `6015`.
- The selected timeline item exposes only runtime `Opacity` and `Motion` components, but its saved component chain contains that AEMask2 mask and tracked parameter. This confirms the saved-stream association despite the scripting object model hiding the mask.
- The parameter stores 122 key entries of 104 bytes each. The first entry is an uninitialized `(0, 0)` point and is omitted; the decoder returns 121 finite XY samples using little-endian float32 values at offsets 64 and 68.
- The decoded trajectory moves from approximately `(0.5156, 0.5301)` to `(0.5503, 0.6189)`. Its timestamps map into the clip's sequence span through the TrackItem in/out points and timeline start/end.
- The workspace parser was executed against the saved `.prproj` in a local Node harness. The live CEP panel rendered and connected to Premiere; the installed JavaScript and JSX files match the workspace build.

## Live Premiere validation

- Premiere Pro 26.3.2 accepted the extracted 121-sample AEMask2 trajectory. QE added Transform to a disposable video clip, and the writer created and read back all 121 `Transform → Position` keys. The host inspector confirmed the keyframe stream and first/last values.
- The first rendered Stabilize comparison showed overcorrection when the writer multiplied normalized tracker deltas by the source clip's 190% Motion Scale. The writer now converts source-normalized deltas by source/sequence frame dimensions only. On the follow-up render, three matched frames showed the face staying broadly in place; this was a visual comparison, not a pixel-level motion measurement.
- The corrected writer wrote and read back 121 inverse keys on a disposable video overlay. Three Program renders at 0.083, 2.503, and 4.713 seconds showed the stabilization trajectory. The temporary overlay exposed underlying untransformed footage at frame edges, so this did not measure final edge fill.
- The corrected writer wrote and read back 118 Follow keys on a disposable MOGRT. Three Program renders at 1.502, 2.503, and 3.504 seconds showed the title moving along the tracked face path. Its default large title overlaps the face, so this was used to verify movement rather than judge the final title design.
- Clear removed all 121 video keys and all 118 graphic keys. It verified timestamps and values, removed only the recorded keys, and restored each initially static Position property to a static baseline.
- The test video overlay's Motion Position and Scale were set to match the source clip. Transform held the generated motion; the original source TrackItem was not modified.
- Both disposable clips were removed with lift. Premiere's track listing confirmed the five original V1 clips and original audio items remained, V2/V3 were empty, selection was empty, and the project was clean.
- Transform keyframe state was verified through Premiere's scripting inspector and exported Program frames. Manual Effect Controls inspection and close/reopen persistence testing remain unavailable because the desktop-control inventory exposes no native Premiere window. The updated CEP files have been copied to the install directory; the visible panel page has not been reloaded.

## Implemented safeguards

- The UI can read/cache a source trajectory, choose X/Y and Follow/Stabilize, apply it to a target, and clear recorded generated keys.
- Follow finds Transform by match name with a controlled display-name fallback. If missing, it attempts a QE add and verifies the resulting component before writing. Stabilize instead writes inverse motion to the built-in Motion Position only and does not add Transform or animate Scale.
- The writer refuses ambiguous Transform or Position matches, unreadable key state, pre-existing Position animation, and tracks with no target time overlap.
- It captures the selected Position baseline, converts normalized or pixel values based on the observed value, writes clip-local Premiere `Time` keys without refreshing the UI on every key, and reads every generated key back. Follow targets Transform Position; Stabilize targets Motion Position. Write failures trigger rollback attempts.
- Clearing compares both timestamp and value, preserving keys that the user has edited.

## Object Mask and Auto Scale boundary

### Target tracking behavior

Follow preserves the target Transform Position and Scale at the first overlapping tracked frame, which keeps layouts such as the “BALL” label beside the ball. Auto Scale remains an optional size change around that baseline. The former Fit target frame to mask experiment was removed because its rendered placement and sizing were not reliable across PNG targets.

The Object Mask format was validated against five Premiere 26.3.2 control projects in `C:\controls` and two clips in `Test Edit_1.prproj`. The reader resolves Tracker UUID references and selects the PRMF decoder from valid sidecar contents instead of private-data hash values. It reads the timestamp attached to each record, so payload order can differ from frame order, and aligns sidecar times to the saved source frame grid. For trimmed clips it discards data outside the selected source range. Single-record sidecars remain reference candidates and are excluded from temporal motion; missing times inside a multi-frame sidecar are inferred only when timestamped records establish one consistent payload offset.

The older TrackItem `1000630` snapshot provided a separate 1-, 4-, and 96-record PRMF corpus and a 98-frame union, but the current project file at that path has since been saved without its former Object Mask reference. It remains forensic evidence and is not the live integration fixture. The control samples establish timestamped and timestamp-omitted record shapes. The reader rejects unknown record layouts, unresolvable sidecar data, bad payload coverage, source dimension changes, gaps in the tracked clip range, and unresolved duplicate geometry.

Existing Auto-Save snapshots remain uncontrolled comparisons: a 1,136-byte referenced file is byte-identical across snapshots, while a 234,396-byte sidecar differs from the current 224,112-byte file in 649 byte ranges. After deriving the candidate schema from the current references, the older 234,396-byte Object Mask sidecar was used as a held-out parser check: it yields 98 timestamps and all 98 align with the current three-file union; 89 rectangles match exactly, and the other 9 differ by at most 5 pixels in any coordinate. The saves do not isolate which edit caused those small differences, so they cannot replace controlled motion/scale samples. The three current references independently report 1, 4, and 96 records (101 source records total); their canonical union contains 98 distinct timestamps and matches TrackItem `1000630`'s 98-frame source interval exactly. Two overlaps are exact duplicates; the third resolves by coordinate-wise median with 2 px maximum coordinate disagreement. No large conflict remains at the default 5 px tolerance.

The machine-readable control report passes static, horizontal, vertical, scale-up, and scale-down behavior. All five streams decode to 20 frames on the saved source-time grid. Horizontal and vertical samples isolate the corresponding center axis; scale-up/down width and height change monotonically by roughly +39% and −43%. The scale controls retain measurable X center drift (+33.5 px and −53.5 px respectively), recorded as a limitation. The panel enables Position and Scale only after the full frame grid validates; Auto Scale stays unavailable for classic point streams. Live Premiere confirmed 20 Transform Position keys and 40 Transform Scale keys on the scale-down graphic, and the user confirmed the scale-up behavior too. The 1→2→3 frame progression remains optional format research. Full field mapping and repeatable commands are in [PRMF v3 findings](object-mask-prmf-v3-findings.md).

The separate TrackItem `1000298` legacy AEMask2 sample contains 122 104-byte key payloads (121 usable XY samples) and is still covered by the registered Premiere 26.x point parser. The sample's known classic private-data hash distinguishes it from the Object Mask component above. Position can be generated from this point stream, but it does not supply per-frame bounds. The previously explored affine-matrix determinant is only a diagnostic hypothesis and is no longer used to generate Scale.

For validated Object Mask PRMF tracks, the UI enables Auto Scale and the writer computes `sqrt((width/referenceWidth) × (height/referenceHeight))` against the user's existing Transform Scale baseline. Position follows the decoded bounding-box center from the existing Position baseline; the plugin does not write Anchor Point. Rotation remains unsupported. The legacy classic-mask path still has point-only capability and cannot enable Auto Scale. Adobe's public UXP `ObjectMaskUtils` API documents only a project/sequence presence boolean, and Adobe staff have said the sidecar contents are not planned to be documented. Live Premiere Position/Scale keyframe write/readback is confirmed on the Object Mask scale controls.

## Acceptance status

| Acceptance | Status |
|---|---|
| 1. Face Object Mask Follow | Decoder checked against five controlled projects and a separate 96-frame project. Live Position/Scale write/readback confirmed on scale-up/down graphics. The 121-sample legacy stream is still a separate classic-mask record. |
| 2. Apply same track to text graphic | 118 keys were written/read back on a disposable MOGRT; rendered frames showed the graphic moving along the face trajectory. |
| 3. Stabilize source footage | Legacy point-stream behavior was exercised on a disposable video overlay. It does not validate Object Mask extraction. |
| 4. Stabilize through Motion Position | Stabilize now targets the built-in Motion Position only to avoid attaching the Object Mask to a newly added Transform. Live Premiere verification is pending. |
| 5. Editable keyframes visible in Premiere | Host inspector confirmed editable Transform Position keys and every written value read back; manual Effect Controls/timeline inspection remains. |
| 6. Motion persists after closing panel | Keys are ordinary Premiere Transform data. Close/reopen persistence has not been manually checked. |

## Phase status

| Phase | Status |
|---|---|
| 1. CEP shell and ExtendScript bridge | Complete; rendered panel and live host connection confirmed. |
| 2. Selected TrackItem inspector | Complete; component/property/runtime inspection confirmed. |
| 3. Track extraction proof | Complete for the legacy classic AEMask2 point stream and experimental for Premiere 26.x Object Mask PRMF v3 rectangle streams. |
| 4. Transform test | Live add/find and 121-key write/readback confirmed. |
| 5. Connect extracted trajectory | 121 keys from the extracted trajectory verified against the source delta on the host. |
| 6. Follow mode | Key writing to a separate MOGRT target and three-frame rendered movement verified. |
| 7. Stabilize mode | Inverse keys and a three-frame rendered comparison verified; some residual motion remains. |

Remaining checks are manual Effect Controls inspection and close/reopen persistence. The 1→2→3 frame-count comparison is optional format research. The PRMF raster codec remains unidentified, but it does not prevent reading the explicit rectangle fields. Run `node tests\object-mask-controls.test.js C:\controls` for the project-reader and solver control check; `python tools\object_mask_forensics.py validate-controls C:\controls\object-mask-control-manifest.json` regenerates the forensic report. `node tests\project-reader-sample.js` retains the classic-mask regression path. The former Object Mask TrackItem ID `1000630` is no longer current; the separate 96-frame Object Mask in `Test Edit_1.prproj` is TrackItem `1000644`.

## Adobe references

- [Object Mask data storage in Premiere](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/object-masking.html) — documents the adjacent `<Project Name> Masks` folder and the requirement to keep that folder with the project.
- [Premiere UXP ObjectMaskUtils](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/objectmaskutils) — documents `hasObjectMask`, which returns a boolean and does not expose track samples.
