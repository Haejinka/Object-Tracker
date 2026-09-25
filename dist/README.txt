# Object Tracker: installation and quick start

## Install

1. Run **Object Tracker-Setup-0.1.0.exe** and follow the setup wizard. It installs Object Tracker for your Windows account; administrator access is not required.
2. Leave **CEP 12 developer mode** enabled in the installer. The extension is unsigned and Premiere needs this setting to load it.
3. Restart Premiere Pro.
4. Open **Window > Extensions > Object Tracker**.

Object Tracker is for Adobe Premiere Pro 26.x. Its private project and mask readers have not been validated for Premiere Pro 27.x.

## Track a mask

1. Open the sequence and save the Premiere project. The project needs a file path, and its adjacent `Masks` folder must remain accessible.
2. Select one video timeline clip that contains a tracked Object Mask or supported classic mask. Linked audio may also be selected, but select only one video clip.
3. In Object Tracker, click **Detect**. Wait for the source name and frame count to appear. Detect saves the project and reads the mask track.
4. Select the video or graphic clip to move, in the same sequence, and click **Use Selection**.
5. Choose **Follow** to move the target with the tracked subject, or **Stabilize** to apply inverse movement. Choose the **X** and **Y** axes to write; at least one must be selected.
6. Optional: in Follow mode, enable **Scale** when it becomes available to follow validated Object Mask size changes. Enable **Motion Blur** to set the target's Transform effect shutter angle to at least 180 degrees.
7. Place the target where it should appear on the first tracked frame before using Follow. Keep it selected and click **Apply Tracking** until the operation completes.
8. Save the Premiere project to keep the keyframes.

## What the modes change

- **Follow** writes editable Transform Position keyframes on the target.
- **Scale** adds Transform Scale keyframes when Object Tracker has validated per-frame Object Mask size data. It is unavailable for classic mask tracks.
- **Motion Blur** sets one static shutter angle on the target's Transform effect. Premiere must expose that control.
- **Stabilize** writes inverse movement to the target's built-in Motion Position. Scale is unavailable in this mode.

The panel moves or scales the whole target clip. It does not fit the clip's visible artwork, transparency, crop, or anchor point to the mask. Rotation and perspective are not tracked.

## If something does not work

- **The panel is missing:** restart Premiere after setup and check **Window > Extensions > Object Tracker**. Confirm CEP 12 developer mode is enabled for this Windows account.
- **Detect cannot find a track:** save the project first, confirm the source clip contains a supported tracked mask, and keep the project and its adjacent `Masks` folder together.
- **Apply Tracking stops:** keep the target selected, use a target in the same sequence, and make sure the source and target overlap in time. The target must not already have Position animation that conflicts with the write.
- **The result is offset:** set the target's initial placement before applying Follow. Source Motion Scale, rotation, pixel aspect ratio, nested sequences, and the target's visible artwork can affect alignment.

To remove generated keyframes, edit them in Premiere Pro's Effect Controls; Object Tracker does not currently have a clear-keys button.
