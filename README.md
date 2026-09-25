# Object Tracker

Object Tracker is an Adobe Premiere Pro 26+ CEP panel. It reads tracked `AE.ADBE AEMask2` data from the saved project and writes ordinary Premiere Position keyframes. Follow targets use `Transform → Position`; Stabilize uses the clip's built-in `Motion → Position`.

## Current workflow

1. Select one timeline clip containing a supported classic AEMask2 point track or a Premiere 26.x Object Mask with PRMF v3 sidecars.
2. Click **Read Track Source**. The panel saves the open project through Premiere, then reads the latest saved tracker data. Save the project once first so Premiere has a project path.
3. Select one video or graphic clip in the same sequence and choose **Follow** or **Stabilize**. Follow uses Transform Position and keeps the target's placement. **Auto Scale** is available only in Follow mode and changes target size as validated mask bounds change. Stabilize writes inverse movement to the clip's built-in Motion Position only; it does not add Transform or use mask bounds.
4. Click **Apply to Selected Target**. Follow reuses a single existing Transform or attempts to add one through QE, captures its current Position and Scale, and writes only when those properties are unanimated. Stabilize uses the single built-in Motion component and writes only Position keys.
5. Use **Clear Generated Keys on Selected Target** to remove keys whose timestamps and values still match Object Tracker's saved record. Edited keys are retained.

The panel caches a decoded track so it can be applied to more than one target. Follow keeps the target's existing placement and size, with Auto Scale available for validated Object Mask bounds. The source-to-sequence position mapping stays on the previously calibrated path because applying source Motion scale again overcorrected a live sample. Auto Scale remains disabled for point-only classic-mask streams. The 2×2 matrix in the legacy 104-byte stream is only a diagnostic hypothesis; it is not used as mask size. Tracked-object rotation is not extracted.

## Support boundary

The versioned legacy decoder reads the `Tracker` parameter on an `AE.ADBE AEMask2` component, using the observed Premiere 26.x 104-byte sample layout and XY float values at byte offsets 64 and 68. The Object Mask path resolves the selected component's Tracker UUIDs and reads rectangle/time records from PRMF v3 trailer tables. It requires Premiere 26.x, full source-frame timing coverage, valid payload ranges, and a consistent source-dimension pair before reporting bounds or enabling Auto Scale. Untimed singleton reference sidecars are preserved as metadata but excluded from the timeline. It identifies known classic-mask and Object Mask component hashes, and reports unknown hashes as unconfirmed.

Five Premiere 26.3.2 controls in `C:\controls` pass the geometry checks and the JavaScript reader/solver tests: static, horizontal, vertical, scale-up, and scale-down. A separate 96-frame project uses another nested Object Mask identifier and the same PRMF v3 layout; its sidecar times cover the saved source-frame grid. Premiere also wrote and verified 20 Transform Position keys and 40 Transform Scale keys on the scale-down graphic; the scale-up behavior was confirmed too. The decoder is limited to Premiere 26.x. The one→two→three frame-count comparison remains optional format research. See [docs/object-mask-prmf-v3-findings.md](docs/object-mask-prmf-v3-findings.md) for the field layout, control results, and remaining checks.

## Development status

| Phase | Status |
|---|---|
| 1. CEP shell and ExtendScript bridge | Complete; panel rendered and connected to Premiere Pro 26.3.2. |
| 2. Selected TrackItem inspector | Complete; components, properties, values, key data, and runtime members were inspected. |
| 3. Track extraction proof | Classic point stream verified; experimental PRMF v3 Object Mask decoder validated against five controlled projects and integrated with the tracking solver. |
| 4. Transform add/find and keyframe test | Live QE add and 121-key write/readback verified on a disposable video clip. |
| 5. Connect extracted trajectory to Transform | Live 121-key write/readback confirmed from the legacy point stream. |
| 6. Follow another clip or graphic | 118 keys verified on a disposable MOGRT; three exported Program frames showed the graphic moving with the face track. The MOGRT's large title overlaps the face. |
| 7. Stabilize mode | 121 inverse keys verified on a disposable video target; three exported Program frames showed the face staying broadly in place. This validation used a legacy classic-mask point stream and does not validate Object Mask extraction. |

For current findings, candidate field mapping, measurements, codec checks, and repeatable commands, see [docs/object-mask-prmf-v3-findings.md](docs/object-mask-prmf-v3-findings.md), [docs/implementation-status.md](docs/implementation-status.md), and [docs/reference-tracker-analysis.md](docs/reference-tracker-analysis.md).

## Install for local development

Copy this folder to:

```text
%APPDATA%\Adobe\CEP\extensions\com.objecttracker.premiere
```

Then reopen **Window → Extensions → Object Tracker** in Premiere. Unsigned local CEP builds may require the host's existing CEP developer-mode setup.

## Architecture

```text
Saved .prproj + adjacent Masks folder
        ↓
Object Mask detector       component hash + selected Tracker UUID links
        ↓
TrackingDataExtractor
  ├─ Experimental PRMF v3 rectangle/time decoder; five control projects
  └─ Legacy 26.x parser     supported 104-byte AEMask2 point stream
        ↓
TrackingNormalizer        normalized point motion and validated Object Mask bounds
        ↓
MotionSolver              Position supported; Scale gated on Object Mask bounds
        ↓
PremiereTransformWriter   guarded editable Transform Position / Scale keys
```

The project remains CEP / HTML / JavaScript / ExtendScript. The PRMF decoder has passed five controlled geometry samples and live Position/Scale writing was confirmed in Premiere. A separate 1→2→3 frame-count comparison is optional format research. No custom tracker, UXP panel, or After Effects extension is included.
