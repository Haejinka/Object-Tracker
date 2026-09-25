import struct
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import object_mask_forensics as forensics


class ObjectMaskForensicsTests(unittest.TestCase):
    @staticmethod
    def rectangle_record(frame, left=10, top=20, width=20, height=40, source_uuid="sample"):
        return {
            "frame": frame,
            "timeTicks": frame * 1000,
            "left": left,
            "top": top,
            "right": left + width,
            "bottom": top + height,
            "width": width,
            "height": height,
            "sourceWidth": 100,
            "sourceHeight": 200,
            "sourceSidecarUuid": source_uuid,
            "sourceFile": source_uuid + ".prmf",
        }

    def test_prmf_header_reports_payload_and_trailer_bounds(self):
        payload = b"maskdata"
        trailer = bytes(32)
        payload_end = 32 + len(payload)
        data = struct.pack("<4sIIIQQ", b"prmf", 3, payload_end, 0, len(trailer), 32)
        data += payload + trailer
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sample.prmf"
            path.write_bytes(data)
            report = forensics.inspect_prmf_header(str(path))
        self.assertEqual(report["magic"], "prmf")
        self.assertEqual(report["version"], 3)
        self.assertEqual(report["payloadStartOffset"], 32)
        self.assertEqual(report["payloadEndOffset"], payload_end)
        self.assertEqual(report["payloadBytes"], len(payload))
        self.assertTrue(report["trailerLengthMatchesFileEnd"])
        self.assertIn("FlatBuffers-style", report["hypothesis"])

    def test_candidate_geometry_parser_handles_shared_forward_vtable(self):
        payload = b"0123456789ab"
        payload_end = 32 + len(payload)
        file_size = 278
        trailer_bytes = file_size - payload_end
        data = bytearray(file_size)
        struct.pack_into("<4sIIIQQ", data, 0, b"prmf", 3, payload_end, 0, trailer_bytes, 32)
        data[32:payload_end] = payload

        # Root FlatBuffer table points to its config table and a one-entry frame vector.
        struct.pack_into("<I", data, payload_end, 16)
        struct.pack_into("<HH3H", data, 50, 10, 18, 12, 8, 4)
        struct.pack_into("<i", data, 60, 10)
        struct.pack_into("<II", data, 64, 40, 20)
        struct.pack_into("<I", data, 72, 3)

        # Config table with the observed byte-sized flag fields.
        struct.pack_into("<HH3H", data, 78, 10, 12, 8, 6, 7)
        struct.pack_into("<i", data, 88, 10)
        data[94:97] = b"\x08\x01\x01"

        # Vector element points to the frame table.
        struct.pack_into("<II", data, 104, 1, 92)

        # The record reuses a vtable stored after its object (negative displacement).
        struct.pack_into("<i", data, 200, -60)
        struct.pack_into("<I", data, 204, 1)
        struct.pack_into("<4I", data, 208, 10, 20, 30, 40)
        struct.pack_into("<2I", data, 224, 100, 200)
        struct.pack_into("<I", data, 232, len(payload))
        struct.pack_into("<Q", data, 236, forensics.PREMIERE_TICKS_PER_SECOND)
        struct.pack_into("<Q", data, 244, 32)
        struct.pack_into("<HH7H", data, 260, 18, 52, 4, 36, 44, 8, 24, 0, 32)

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "candidate.prmf"
            path.write_bytes(data)
            report = forensics.decode_prmf_v3_candidate_geometry(str(path))
            aggregate = forensics.candidate_geometry_report([str(path)])
        frame = report["candidateFrames"][0]
        self.assertEqual(report["frameCount"], 1)
        self.assertTrue(report["payloadRangesExactlyCoverPayload"])
        self.assertEqual(frame["time"], 1.0)
        self.assertEqual((frame["centerX"], frame["centerY"]), (25.0, 40.0))
        self.assertEqual((frame["width"], frame["height"]), (30, 40))
        self.assertFalse(report["validation"]["pluginIntegrationAllowed"])
        self.assertEqual(aggregate["crossSidecar"]["candidateTimeline"][0]["frame"], 0)
        self.assertFalse(aggregate["crossSidecar"]["candidateTimeline"][0]["ambiguousDuplicate"])
        self.assertEqual(aggregate["diagnostics"]["productionDecodedFrameCount"], 0)

    def test_merges_one_four_and_ninety_six_records_to_98_timestamps(self):
        first = [self.rectangle_record(0, source_uuid="sidecar-a")]
        second = [self.rectangle_record(i, source_uuid="sidecar-b") for i in range(4)]
        third = [self.rectangle_record(i, source_uuid="sidecar-c") for i in range(2, 98)]
        expected = [i * 1000 for i in range(98)]
        merged = forensics.canonical_rectangle_timeline(first + second + third, 5, expected)
        self.assertEqual(merged["recordCount"], 101)
        self.assertEqual(merged["uniqueTimeCount"], 98)
        self.assertEqual(merged["duplicateTimeCount"], 3)
        self.assertEqual(merged["duplicateRecordCount"], 3)
        self.assertEqual(merged["timelineCoverage"]["missingFrameCount"], 0)
        self.assertTrue(merged["timelineCoverage"]["complete"])
        self.assertEqual(merged["candidateTimeline"][97]["frame"], 97)
        self.assertEqual(merged["candidateTimeline"][0]["sourceSidecarUuids"], ["sidecar-a", "sidecar-b"])

    def test_exact_duplicate_is_collapsed_but_provenance_is_preserved(self):
        merged = forensics.canonical_rectangle_timeline([
            self.rectangle_record(0, source_uuid="sidecar-a"),
            self.rectangle_record(0, source_uuid="sidecar-b"),
        ])
        frame = merged["candidateTimeline"][0]
        self.assertEqual(merged["exactDuplicateRecordCount"], 1)
        self.assertEqual(frame["duplicateClassification"], "exact-duplicate")
        self.assertEqual(frame["sourceSidecarUuids"], ["sidecar-a", "sidecar-b"])
        self.assertEqual(frame["left"], 10)
        self.assertFalse(frame["conflict"])

    def test_near_duplicate_uses_coordinate_wise_median(self):
        records = [
            self.rectangle_record(0, left=10, source_uuid="sidecar-a"),
            self.rectangle_record(0, left=12, source_uuid="sidecar-b"),
            self.rectangle_record(0, left=11, source_uuid="sidecar-c"),
        ]
        merged = forensics.canonical_rectangle_timeline(records, conflict_tolerance_px=2)
        frame = merged["candidateTimeline"][0]
        self.assertEqual(frame["duplicateClassification"], "near-duplicate")
        self.assertEqual((frame["left"], frame["right"]), (11, 31))
        self.assertEqual(frame["maximumCoordinateDisagreementPx"], 2)
        self.assertEqual(merged["nearDuplicateTimeCount"], 1)

    def test_missing_times_and_large_conflicts_are_reported(self):
        missing = forensics.canonical_rectangle_timeline(
            [self.rectangle_record(0), self.rectangle_record(2)],
            expected_time_ticks=[0, 1000, 2000])
        self.assertEqual(missing["timelineCoverage"]["missingTimeTicks"], [1000])
        self.assertEqual(missing["candidateTimeline"][1]["frame"], 2)

        conflict = forensics.canonical_rectangle_timeline([
            self.rectangle_record(0, left=10, source_uuid="sidecar-a"),
            self.rectangle_record(0, left=30, source_uuid="sidecar-b"),
        ], conflict_tolerance_px=5)
        frame = conflict["candidateTimeline"][0]
        self.assertEqual(frame["duplicateClassification"], "large-conflict")
        self.assertTrue(frame["conflict"])
        self.assertIsNone(frame["centerX"])
        self.assertEqual(conflict["maximumDuplicateCoordinateDisagreementPx"], 20)

    def test_center_and_normalized_geometry_are_derived_from_source_dimensions(self):
        frame = forensics.canonical_rectangle_timeline([self.rectangle_record(0)])["candidateTimeline"][0]
        self.assertEqual((frame["centerX"], frame["centerY"]), (20, 40))
        self.assertEqual((frame["width"], frame["height"]), (20, 40))
        self.assertEqual((frame["normalizedCenterX"], frame["normalizedCenterY"]), (0.2, 0.2))
        self.assertEqual((frame["normalizedWidth"], frame["normalizedHeight"]), (0.2, 0.2))

    def test_graphic_follow_scale_ratio_grows_and_shrinks_without_inversion(self):
        reference = {"left": 0, "top": 0, "right": 20, "bottom": 40}
        doubled = {"left": 0, "top": 0, "right": 40, "bottom": 80}
        halved = {"left": 0, "top": 0, "right": 10, "bottom": 20}
        self.assertEqual(forensics.geometry_scale_ratio(reference, doubled), 2)
        self.assertEqual(forensics.geometry_scale_ratio(reference, halved), 0.5)

    def test_control_report_checks_horizontal_motion_and_stationary_axes(self):
        timeline = []
        for frame in range(3):
            record = self.rectangle_record(frame, left=10 + frame * 15)
            timeline.append(forensics.canonical_rectangle_timeline([record])["candidateTimeline"][0])
        report = forensics.evaluate_controlled_geometry_sample(
            "horizontal-control", "horizontal", timeline, expected_frame_count=3)
        self.assertEqual(report["status"], "passed")
        self.assertTrue(report["checks"]["horizontalMotionIsSubstantial"]["passed"])
        self.assertTrue(report["checks"]["centerYRemainsConstant"]["passed"])

    def test_control_reports_validate_vertical_and_both_scale_directions(self):
        vertical_frames = []
        for frame in range(3):
            record = self.rectangle_record(frame, top=20 + frame * 15)
            vertical_frames.append(forensics.canonical_rectangle_timeline([record])["candidateTimeline"][0])
        vertical = forensics.evaluate_controlled_geometry_sample(
            "vertical-control", "vertical", vertical_frames, expected_frame_count=3)
        self.assertTrue(vertical["passed"])
        self.assertTrue(vertical["checks"]["centerXRemainsConstant"]["passed"])

        reports = {}
        for direction, sizes in (("scale-up", [(20, 40), (30, 60), (40, 80)]),
                                 ("scale-down", [(40, 80), (30, 60), (20, 40)])):
            timeline = []
            for frame, (width, height) in enumerate(sizes):
                left, top = 50 - width / 2, 100 - height / 2
                record = self.rectangle_record(frame, left=left, top=top, width=width, height=height)
                timeline.append(forensics.canonical_rectangle_timeline([record])["candidateTimeline"][0])
            reports[direction] = forensics.evaluate_controlled_geometry_sample(
                direction, direction, timeline, expected_frame_count=3)
        self.assertTrue(reports["scale-up"]["passed"])
        self.assertEqual(reports["scale-up"]["metrics"]["graphicFollowScaleRatio"], 2)
        self.assertTrue(reports["scale-down"]["passed"])
        self.assertEqual(reports["scale-down"]["metrics"]["graphicFollowScaleRatio"], 0.5)

    def test_control_manifest_emits_machine_readable_missing_control_status(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest_path = Path(folder) / "controls.json"
            manifest_path.write_text(json.dumps({"samples": []}), encoding="utf-8")
            report = forensics.validate_control_manifest(str(manifest_path))
        self.assertEqual(report["controlledValidationStatus"], "incomplete-or-failed")
        self.assertEqual(report["missingBehaviors"], ["horizontal", "scale-down", "scale-up", "static", "vertical"])
        self.assertFalse(report["experimentalPromotionEligible"])
        self.assertFalse(report["productionObjectMaskIntegrationEnabled"])

    def test_byte_diff_reports_ranges_and_length_tail(self):
        changes = forensics.changed_ranges(b"abcdef", b"abXdeY789")
        self.assertEqual(changes[0]["start"], 2)
        self.assertEqual(changes[0]["endExclusive"], 3)
        self.assertEqual(changes[1]["start"], 5)
        self.assertEqual(changes[2]["kind"], "length-only-tail")

    def test_change_map_visualizes_changed_blocks(self):
        report = forensics.changed_block_map(bytes(512), bytes(256) + bytes([255]) * 256, 256)
        self.assertEqual(report["heatmap"], " @")
        self.assertEqual(report["blocks"][0]["changedBytes"], 0)
        self.assertEqual(report["blocks"][1]["changedBytes"], 256)
        self.assertEqual(report["rightOnlyBytes"], 0)

    def test_float_scan_respects_endianness_and_range(self):
        data = struct.pack("<ff", 0.5, -0.25)
        matches = forensics.scan_floats(data, 32, "le", -1, 1, 4)
        self.assertEqual([entry["value"] for entry in matches], [0.5, -0.25])

    def test_signature_detects_prmf_magic(self):
        report = forensics.signatures(b"prmf\x03\x00\x00\x00")
        self.assertEqual(report["known"][0]["signature"], "Premiere mask sidecar")

    def test_raw_deflate_sweep_finds_a_real_stream_at_exact_boundary(self):
        encoder = forensics.zlib.compressobj(wbits=-forensics.zlib.MAX_WBITS)
        stream = encoder.compress(b"controlled payload " * 16) + encoder.flush()
        report = forensics._raw_deflate_sweep(stream)
        self.assertGreaterEqual(report["validStreamCount"], 1)


if __name__ == "__main__":
    unittest.main()
