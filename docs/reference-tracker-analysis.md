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
3. The legacy AEMask2 point stream remains connected to Transform Position. An experimental Premiere 26.x PRMF v3 Object Mask decoder now supplies validated center and bounds from controlled samples to the same motion solver; Auto Scale remains disabled for point-only tracks.
4. Keep normalized trajectory processing independent from the storage reader and keep Transform writing guarded against existing animation.
5. Prefer Transform and report a QE add failure explicitly rather than silently changing Motion.

## Findings in the current project

The historical legacy sample links TrackItem `1000298` to a classic-hash `AE.ADBE AEMask2` component whose Tracker parameter contains 122 entries (121 usable XY samples). Its payload is not the Object Mask stream.

The previously inspected Premiere 26.3.2 project linked TrackItem `1000630` through classic AEMask2 root `1298` to nested component `2348`, with the Object Mask hash and no keyframed Tracker payload. That saved project has since changed; its old ID is not a current test fixture. The controlled samples use the second observed Object Mask hash and provide the validated integration inputs described below.

The current Masks folder contains 16 `.prmf` sidecars, all with a `prmf` v3 header. The three references on Tracker `6437` identify files of 1,136, 19,976, and 224,112 bytes. The corrected layout is a 32-byte header, frame-payload bytes from offset 32 to the declared payload end, and a trailer to EOF. A FlatBuffers-style frame vector in the trailer contains candidate timestamp, rectangle, dimension, and payload-range fields. Payload chunks exactly cover the declared payload range. Exact-block tests for zlib, gzip, raw DEFLATE, Brotli, Zstandard (including magicless), LZ4, Snappy, and LZFSE did not decode the high-entropy chunks. A same-length deterministic-random baseline produced a similar count of tiny arbitrary-offset raw-DEFLATE parses, so those parses are treated as false positives.

The forensic CLI builds a canonical timeline with rectangle edges, center, dimensions, normalized coordinates, timestamp-derived frame index, and UUID provenance. The five projects in `C:\controls` each resolve two real sidecars: a 20-record temporal stream and an untimed singleton reference. Other UUID tokens do not match sidecar filenames. Their 20-frame timelines align with source InPoint and MediaFrameRate. Static, horizontal, vertical, scale-up, and scale-down checks pass. The scale samples show X center drift (33.5 px up; −53.5 px down), even though width/height change monotonically, so this remains a documented limitation. The CEP reader now emits normalized Object Mask frames and only sets bounds/scale capabilities after all records and project timing validate. See [PRMF v3 findings](object-mask-prmf-v3-findings.md) for measurements and repeatable commands.

Two existing Auto-Save snapshots also contain the Object Mask hash. The 14:16 snapshot references 1,136-byte and 234,396-byte files in its matching Masks folder; the 14:22 snapshot references a 1,136-byte and a 234,396-byte file by UUID, though its matching folder is absent. The 1,136-byte file is byte-identical to the current project's 1,136-byte sidecar. Comparing the 234,396-byte snapshot file with the current 224,112-byte reference reports 649 changed ranges and a changed body. This chronology is uncontrolled: the saves do not identify which edit changed the sidecar, so it cannot yet map bytes to tracking, movement, bounds, or time.

Adobe says the Object Mask data is stored in the adjacent `<Project Name> Masks` folder and must travel with the project ([Object Masking in Premiere](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/object-masking.html)). Adobe's documented UXP `ObjectMaskUtils` API exposes a presence boolean, not the per-frame samples ([ObjectMaskUtils](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/objectmaskutils)); Adobe staff have said they do not plan to document the sidecar contents ([Adobe Community thread](https://community.adobe.com/questions-729/new-masking-object-mask-data-in-the-external-file-1419998)).

## Remaining evidence needed

The parser-to-solver path has passed Node checks on all five controlled projects, and Scale factors follow the supplied formula without inversion. Still open are the one→two→three frame-count save progression, live Premiere Transform Position/Scale write and readback using an Object Mask source, and manual Effect Controls/persistence checks. The high-entropy frame payload codec remains unknown; it is unnecessary for geometry because the PRMF trailer exposes the rectangle metadata.
