# Historical reference panel analysis

This note records an earlier read-only inspection of the installed Neathue Premiere Pro Tracker panel at:

    %APPDATA%\Adobe\CEP\extensions\com.neathue.tracker

Its code was inspected to understand a similar workflow. It was not copied into Object Tracker.

## Observed reference behavior

The panel separated a source clip with a tracked mask from a destination clip that received motion. It offered attach, attach-and-center, and stabilize actions. The inspected implementation read saved Premiere project data, found keyframed AEMask2 Tracker parameters, and interpreted observed 104-byte entries as normalized XY samples. It did not transfer tracking through a direct Premiere command or analyze the video image.

The reference tried several ways to add Transform and could fall back to intrinsic Motion. It could clear existing Position keys and refreshed the host UI during key writes. Those behaviors motivated explicit target selection, guarded writes, readback, and clear-only-recorded-keys in Object Tracker.

The details above describe the installed reference version that was inspected. They are not claims about every version of that panel.

## How Object Tracker differs now

Object Tracker reads the selected timeline clip's own saved component chain instead of choosing a project-wide candidate. It supports two validated Premiere 26.x source formats:

- Classic AEMask2's observed 104-byte point stream supplies point motion only.
- Object Mask's linked PRMF v3 sidecars supply validated per-frame rectangle centers and bounds after record, timing, and geometry checks.

Follow writes Transform Position and can optionally apply Object Mask size changes to Transform Scale. Stabilize writes inverse movement to the target's built-in Motion Position only; it does not add Transform or change Scale. A guarded clear routine exists in the host JSX, but the current panel does not expose or call it, so users remove generated keys through Premiere's Effect Controls.

The old exploratory project IDs and hash descriptions in earlier notes referred to individual saved projects. TrackItem IDs and Object Mask private hashes vary between projects and saves. Current source detection follows the selected tracker's UUID sidecar links and validates their contents.

See [implementation status](implementation-status.md) for supported behavior and validation boundaries, and [PRMF v3 findings](object-mask-prmf-v3-findings.md) for the sidecar layout and evidence.
