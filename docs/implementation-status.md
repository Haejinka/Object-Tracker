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
- The writer finds Transform by match name with a controlled display-name fallback. If missing, it attempts a QE add and verifies the resulting component before writing. It never falls back to Motion.
- The writer refuses ambiguous Transform or Position matches, unreadable key state, pre-existing Position animation, and tracks with no target time overlap.
- It captures the Transform Position baseline, converts normalized or pixel values based on the observed value, writes clip-local Premiere `Time` keys without refreshing the UI on every key, and reads every generated key back. Write failures trigger rollback attempts.
- Clearing compares both timestamp and value, preserving keys that the user has edited.

## Object Mask classification boundary

The current project has five `.prmf` sidecars in the project-adjacent Masks folder. Three are 24,076 bytes each and byte-identical; the other two are 3,163,700 and 1,992,964 bytes. Their UUID filenames do not appear as text or raw UUID bytes in the decompressed `.prproj`, and the project XML contains no `.prmf` paths. The file headers identify `prmf` version 3, but this build does not decode the sidecar format.

The selected item's `AEMask2` Tracker stream is separate and decodes to 121 XY samples. The current project evidence does not establish whether that AEMask2 instance represents a classic vector mask or Premiere's newer Object Mask. The implementation reports the mask subtype as unconfirmed. Adobe documents the external sidecar folder, while its documented UXP `ObjectMaskUtils` interface exposes only a project/sequence presence boolean and no tracking samples. This extension remains CEP by requirement.

## Acceptance status

| Acceptance | Status |
|---|---|
| 1. Face Object Mask Follow | A 121-sample AEMask2 Tracker stream was extracted from the selected face clip and rendered through a graphic. Whether the stream belongs to the newer Object Mask feature remains unconfirmed. |
| 2. Apply same track to text graphic | 118 keys were written/read back on a disposable MOGRT; rendered frames showed the graphic moving along the face trajectory. |
| 3. Stabilize source footage | 121 inverse keys were written/read back on a disposable video overlay; three rendered frames showed the face staying broadly in place. |
| 4. Preserve Motion Position | Verified on the disposable video target; Motion Position remained unchanged. |
| 5. Editable keyframes visible in Premiere | Host inspector confirmed editable Transform Position keys and every written value read back; manual Effect Controls/timeline inspection remains. |
| 6. Motion persists after closing panel | Keys are ordinary Premiere Transform data. Close/reopen persistence has not been manually checked. |

## Phase status

| Phase | Status |
|---|---|
| 1. CEP shell and ExtendScript bridge | Complete; rendered panel and live host connection confirmed. |
| 2. Selected TrackItem inspector | Complete; component/property/runtime inspection confirmed. |
| 3. Track extraction proof | Complete for the observed AEMask2 Tracker stream; its mask subtype is unconfirmed. |
| 4. Transform test | Live add/find and 121-key write/readback confirmed. |
| 5. Connect extracted trajectory | 121 keys from the extracted trajectory verified against the source delta on the host. |
| 6. Follow mode | Key writing to a separate MOGRT target and three-frame rendered movement verified. |
| 7. Stabilize mode | Inverse keys and a three-frame rendered comparison verified; some residual motion remains. |

The remaining checks are to identify which mask subtype owns the selected AEMask2 stream, inspect the generated keys manually in Effect Controls, and close/reopen the panel to check persistence. No automated test suite is included; the focused extraction harness used the actual local saved project.

## Adobe references

- [Object Mask data storage in Premiere](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/object-masking.html) — documents the adjacent `<Project Name> Masks` folder and the requirement to keep that folder with the project.
- [Premiere UXP ObjectMaskUtils](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/objectmaskutils) — documents `hasObjectMask`, which returns a boolean and does not expose track samples.
