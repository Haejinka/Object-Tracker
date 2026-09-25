# Object Tracker

Object Tracker is an Adobe Premiere Pro 26+ CEP panel. It reads a tracked `AE.ADBE AEMask2` stream from the saved project, converts its normalized XY samples into a reusable trajectory, then writes ordinary keyframes to `Transform → Position`.

## Current workflow

1. Select one timeline clip containing a completed Premiere mask track.
2. Click **Read Track Source**. The reader requires a saved, clean project and does not save or modify the project.
3. Select one video or graphic clip in the same sequence and choose **Follow** or **Stabilize**. For Follow, set the target's Transform Position where the graphic should begin; add Transform manually first if you need to choose a starting point.
4. Click **Apply to Selected Target**. The writer reuses a single existing Transform or attempts to add one through QE, captures its current Position, and writes only when Position is unanimated.
5. Use **Clear Generated Keys on Selected Target** to remove keys whose timestamps and values still match Object Tracker's saved record. Edited keys are retained.

The panel caches the normalized track so it can be applied to more than one target. Motion Position is not changed. The trajectory is mapped to overlapping sequence time and converted from source-normalized coordinates using the source and sequence dimensions. A live Premiere render check showed that also multiplying by the source clip's Motion Scale overcorrected this stream, so that scale is not applied again.

## Support boundary

The current decoder reads the `Tracker` parameter on an `AE.ADBE AEMask2` component, using the observed 104-byte sample layout and XY float values at byte offsets 64 and 68. It associates the stream through the selected timeline item's serialized `SelectionComponents` chain. This is verified against the saved `Test Edit_1.prproj` sample in this development environment. Premiere's scripting data does not identify whether the selected mask is a classic vector mask or a newer Object Mask.

Premiere's newer Object Mask also stores substantial mask data in adjacent `.prmf` sidecar files. This build does not decode or associate those files. The current project contains both those sidecars and an AEMask2 Tracker stream attached to the selected clip, but the available data does not prove whether that stream belongs to a classic mask or an Object Mask. The panel reports the classification as unconfirmed instead of labeling it as either type.

## Development status

| Phase | Status |
|---|---|
| 1. CEP shell and ExtendScript bridge | Complete; panel rendered and connected to Premiere Pro 26.3.2. |
| 2. Selected TrackItem inspector | Complete; components, properties, values, key data, and runtime members were inspected. |
| 3. Track extraction proof | Complete for the observed AEMask2 Tracker stream (121 usable samples); its mask subtype is unconfirmed. |
| 4. Transform add/find and keyframe test | Live QE add and 121-key write/readback verified on a disposable video clip. |
| 5. Connect extracted trajectory to Transform | Live 121-key write/readback confirmed from the extracted source track. |
| 6. Follow another clip or graphic | 118 keys verified on a disposable MOGRT; three exported Program frames showed the graphic moving with the face track. The MOGRT's large title overlaps the face. |
| 7. Stabilize mode | 121 inverse keys verified on a disposable video target; three exported Program frames showed the face staying broadly in place. Some residual motion remains and the native mask subtype is unconfirmed. |

For the exact current findings and mask classification status, see [docs/implementation-status.md](docs/implementation-status.md) and [docs/reference-tracker-analysis.md](docs/reference-tracker-analysis.md).

## Install for local development

Copy this folder to:

```text
%APPDATA%\Adobe\CEP\extensions\com.objecttracker.premiere
```

Then reopen **Window → Extensions → Object Tracker** in Premiere. Unsigned local CEP builds may require the host's existing CEP developer-mode setup.

## Architecture

```text
Premiere saved-project AEMask2 stream
        ↓
js/project-reader.js       exact TrackItem association + XY decoding
        ↓
NormalizedTrack            relative XY + source and sequence timing
        ↓
jsx/transform.jsx          Transform lookup/add + guarded Position writer
        ↓
Editable Premiere Position keyframes
```

The project remains CEP / HTML / JavaScript / ExtendScript. No video-frame analysis, custom tracker, UXP panel, or After Effects extension is included.
