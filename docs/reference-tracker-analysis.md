# Reference analysis: installed Tracker CEP panel

This note records a read-only inspection of the installed `Neathue Premiere Pro Tracker` panel at `%APPDATA%\Adobe\CEP\extensions\com.neathue.tracker`. Its code was used to understand the workflow; it was not copied into this project.

## What the panel does

The panel separates a source clip (where the tracked mask lives) from a destination clip (where motion is written). It scans the project for tracked masks, offers Attach, Attach and Move to Center, and Stabilize modes, and writes Position keys to a Transform effect when it can. It can also thin keys and map source-space motion using source dimensions and the clip's Motion scale, position, and rotation.

The core is a **read serialized mask-track data, then write keyframes** pipeline. The inspected code does not use a Premiere command that transfers the track directly, nor does it analyze video frames.

## How its track reader works

The panel enables CEP Node access and reads the saved `.prproj` file with Node's filesystem APIs. If the file begins with the gzip header, it decompresses it and searches the resulting project XML. It looks for keyframed `ArbVideoComponentParam` blocks named `Tracker` and associates them with `AE.ADBE AEMask2` components through parameter references.

In the format this reader expects, each keyframe entry contains a Premiere tick value and Base64 payload. It accepts a 104-byte payload and interprets two little-endian float32 values at byte offsets 64 and 68 as normalized X/Y coordinates. It omits `(0, 0)` placeholder samples. The reader uses a nearby mask Position parameter as a fingerprint when trying to scope a discovered tracker to the selected source clip; it also deduplicates repeated tracker records.

Those are concrete details of the installed reader's supported format. The current project's selected TrackItem is associated with a matching AEMask2 Tracker parameter, but the project representation does not label the mask subtype. The reference reader's project-wide scan is not, by itself, proof that a candidate belongs to a particular timeline clip.

## Keyframe writing and behaviors to avoid inheriting

The writer finds Transform by `AE.ADBE Geometry2` or display name, tries several undocumented effect-add paths, then attempts QE. If it cannot add Transform, it falls back to intrinsic Motion. That fallback is useful for compatibility but does not meet this project's preference to keep Motion untouched.

The reference can remove every existing key from the selected Position parameter before writing. Our implementation must not do that silently: existing animation needs a clear conflict path, and clearing must be limited to keys Object Tracker created. The reference also refreshes the host UI on each key write, which may be slow on long tracks.

For timing, its writer tests both session-time and clip-relative interpretations and chooses whichever places more samples inside the target clip. It converts sequence time to target-clip time using the clip start and in-point. Object Tracker instead maps the saved tracker ticks through the selected TrackItem's in/out points and sequence start/end; the current decoded source trajectory and target keyframe stream were accepted by Premiere, while a visual Object Mask trim-alignment check remains.

## Implications for Object Tracker

1. Keep the runtime inspector and read-only project reader separate. The selected TrackItem's tracker data is in the saved component chain even though the runtime component list exposes only Motion and Opacity.
2. Resolve trackers through the selected TrackItem's own component references; do not use project-wide candidates alone to choose a source.
3. The AEMask2 Tracker stream is now connected to the Transform writer. The stream's mask subtype and its visual alignment to the Object Mask subject still need a controlled Premiere comparison.
4. Keep normalized trajectory processing independent from the storage reader and keep Transform writing guarded against existing animation.
5. Prefer Transform and report a QE add failure explicitly rather than silently changing Motion.

## Findings in the current project

The selected timeline item exposes only Motion and Opacity through ExtendScript. Its saved `.prproj` chain nevertheless links TrackItem `1000298` to an `AE.ADBE AEMask2` component with nested mask instance `05` and a time-varying `Tracker` parameter containing 122 entries (121 usable XY samples). Thus the stream is associated with the selected clip even though Premiere's scripting object model hides the mask component.

The adjacent Masks folder contains five `.prmf` sidecars. The project has no textual or raw UUID references to their filenames and no textual `.prmf` paths. Adobe documents the folder requirement, but neither the public CEP/ExtendScript tree nor the documented UXP presence check identifies which mask subtype produced this `AEMask2` stream. The extracted coordinates have not been visually checked against the tracked face in Premiere, so the source is reported as an AEMask2 mask tracker with subtype unconfirmed.

## Remaining evidence needed

Use a controlled native Object Mask example and compare its saved component stream before/after tracking, then verify the extracted point against the visible mask in Premiere. If the AEMask2 Tracker parameter is populated, the current parser may already cover the tracking trajectory; if not, the `.prmf` format or another Premiere-supported transfer path still needs investigation. The installed Tracker's matching AEMask2 parser is evidence for the storage route, but not by itself proof of Object Mask semantics.
