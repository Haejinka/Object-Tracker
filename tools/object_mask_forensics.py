#!/usr/bin/env python3
"""Inspect and compare Premiere Object Mask sidecars and project payloads.

The core commands use only the Python standard library. `codec-scan` will also
use optional codec packages when available. This is a research aid: a detected
signature is not a decoder, and numeric scans need independent validation.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import math
import struct
import sys
import zlib
import uuid as uuidlib
from collections import Counter
from pathlib import Path
import re
import random
import xml.etree.ElementTree as ET

PREMIERE_TICKS_PER_SECOND = 254016000000

SIGNATURES = {
    b"prmf": "Premiere mask sidecar",
    b"\x1f\x8b": "gzip",
    b"PK\x03\x04": "ZIP",
    b"\x28\xb5\x2f\xfd": "Zstandard frame",
    b"\x04\x22\x4d\x18": "LZ4 frame",
    b"\xff\x06\x00\x00sNaPpY": "Snappy framed stream",
    b"bvx1": "LZFSE stream",
    b"bvx2": "LZFSE stream",
    b"bvxn": "LZFSE stream",
    b"bvx-": "LZFSE stream",
    b"\x89PNG\r\n\x1a\n": "PNG",
    b"\xff\xd8\xff": "JPEG",
    b"II*\x00": "TIFF little-endian",
    b"MM\x00*": "TIFF big-endian",
    b"SQLite format 3\x00": "SQLite",
}


def read_file(path: str) -> bytes:
    return Path(path).read_bytes()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def shannon_entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = Counter(data)
    n = len(data)
    return -sum((count / n) * math.log2(count / n) for count in counts.values())


def signatures(data: bytes) -> dict:
    found = []
    zlib_offsets = zlib_header_offsets(data)
    for magic, label in SIGNATURES.items():
        start = 0
        while True:
            offset = data.find(magic, start)
            if offset < 0:
                break
            found.append({"offset": offset, "signature": label, "hex": magic.hex(" ")})
            start = offset + 1
    return {"known": sorted(found, key=lambda item: item["offset"]),
            "zlibCandidateCount": len(zlib_offsets), "zlibCandidateOffsets": zlib_offsets[:64]}


def zlib_header_offsets(data: bytes) -> list[int]:
    """Return RFC 1950 CMF/FLG candidates; successful decompression is still required."""
    offsets = []
    for offset in range(max(0, len(data) - 1)):
        cmf, flg = data[offset], data[offset + 1]
        if (cmf & 0x0F) == 8 and (cmf >> 4) <= 7 and ((cmf << 8) | flg) % 31 == 0:
            offsets.append(offset)
    return offsets


def repeated_windows(data: bytes, size: int, limit: int = 12) -> list[dict]:
    if size <= 0 or len(data) < size:
        return []
    # Non-overlapping samples prevent a long zero run from dominating results.
    counts = Counter(data[offset:offset + size] for offset in range(0, len(data) - size + 1, size))
    return [{"hex": chunk.hex(" "), "count": count} for chunk, count in counts.most_common(limit) if count > 1]


def printable_strings(data: bytes, minimum: int = 8) -> list[dict]:
    found = []
    for encoding, pattern in (("ascii", lambda b: 32 <= b <= 126), ("utf16le", None)):
        if encoding == "ascii":
            start = None
            for offset, byte in enumerate(data + b"\x00"):
                if pattern(byte):
                    if start is None:
                        start = offset
                elif start is not None:
                    if offset - start >= minimum:
                        value = data[start:offset].decode("ascii", "replace")
                        if any(char.isalpha() for char in value) and sum(char.isalnum() or char in " .:/_-" for char in value) / len(value) > 0.9:
                            found.append({"offset": start, "encoding": encoding, "text": value})
                    start = None
        else:
            for offset in range(0, len(data) - minimum * 2, 2):
                end = offset
                while end + 1 < len(data) and data[end + 1] == 0 and 32 <= data[end] <= 126:
                    end += 2
                if end - offset >= minimum * 2:
                    value = data[offset:end:2].decode("ascii", "replace")
                    if any(char.isalpha() for char in value):
                        found.append({"offset": offset, "encoding": encoding, "text": value})
    return found


def entropy_blocks(data: bytes, block_size: int) -> list[dict]:
    return [{"offset": offset, "length": len(data[offset:offset + block_size]),
             "entropy": round(shannon_entropy(data[offset:offset + block_size]), 4)}
            for offset in range(0, len(data), block_size)]


def header_interpretations(data: bytes, limit: int = 128) -> list[dict]:
    output = []
    end = min(len(data), limit)
    for offset in range(0, end - 3, 4):
        word = data[offset:offset + 4]
        le_u32, be_u32 = struct.unpack("<I", word)[0], struct.unpack(">I", word)[0]
        le_f32, be_f32 = struct.unpack("<f", word)[0], struct.unpack(">f", word)[0]
        output.append({"offset": offset, "hex": word.hex(" "), "u32le": le_u32, "u32be": be_u32,
                       "f32le": le_f32 if math.isfinite(le_f32) else None,
                       "f32be": be_f32 if math.isfinite(be_f32) else None})
    return output


def compression_streams(data: bytes) -> dict:
    # Test all valid header candidates. The abbreviated list returned by
    # signatures() is only for compact reports, not a decoder search limit.
    zlib_candidates = zlib_header_offsets(data)
    streams = []
    for offset in zlib_candidates:
        try:
            decoder = zlib.decompressobj()
            decoded = decoder.decompress(data[offset:], 64 * 1024 * 1024)
            if len(decoded) >= 16 and decoder.eof:
                streams.append({"codec": "zlib", "offset": offset, "compressedBytes": len(data[offset:]) - len(decoder.unused_data),
                                "decodedBytes": len(decoded), "decodedPrefixHex": decoded[:32].hex(" "),
                                "decodedPrefixText": decoded[:96].decode("utf8", "replace")})
        except (zlib.error, ValueError):
            continue
    start = 0
    while True:
        offset = data.find(b"\x1f\x8b", start)
        if offset < 0:
            break
        start = offset + 1
        try:
            decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
            decoded = decoder.decompress(data[offset:], 64 * 1024 * 1024)
            if len(decoded) >= 16 and decoder.eof:
                streams.append({"codec": "gzip", "offset": offset, "compressedBytes": len(data[offset:]) - len(decoder.unused_data),
                                "decodedBytes": len(decoded), "decodedPrefixHex": decoded[:32].hex(" "),
                                "decodedPrefixText": decoded[:96].decode("utf8", "replace")})
        except (zlib.error, ValueError):
            continue
    return {"validStreamCount": len(streams), "streams": streams[:64]}


def inspect(path: str, block_size: int) -> dict:
    data = read_file(path)
    blocks = entropy_blocks(data, block_size)
    entropy_values = [block["entropy"] for block in blocks]
    return {
        "path": str(Path(path).resolve()), "size": len(data), "sha256": sha256(data),
        "prefixHex": data[:128].hex(" "), "signatureMatches": signatures(data),
        "entropy": {"wholeFile": round(shannon_entropy(data), 5), "blockSize": block_size,
                    "blockCount": len(blocks), "min": min(entropy_values, default=0), "max": max(entropy_values, default=0),
                    "firstBlocks": blocks[:32]},
        "headerWords": header_interpretations(data), "commonRepeatedBlocks": {
            str(size): repeated_windows(data, size) for size in (4, 8, 16, 32, 64)
        }, "compressionStreams": compression_streams(data), "strings": printable_strings(data)[:100],
    }


def changed_ranges(left: bytes, right: bytes, context: int = 0) -> list[dict]:
    common = min(len(left), len(right))
    ranges = []
    start = None
    for offset in range(common):
        if left[offset] != right[offset]:
            if start is None:
                start = offset
        elif start is not None:
            ranges.append((start, offset))
            start = None
    if start is not None:
        ranges.append((start, common))
    output = []
    for start, end in ranges:
        lo, hi = max(0, start - context), min(common, end + context)
        output.append({"start": start, "endExclusive": end, "length": end - start,
                       "leftHex": left[lo:hi].hex(" "), "rightHex": right[lo:hi].hex(" ")})
    if len(left) != len(right):
        longer = left if len(left) > len(right) else right
        output.append({"start": common, "endExclusive": len(longer), "length": abs(len(left) - len(right)),
                       "kind": "length-only-tail", "hex": longer[common:common + min(64, len(longer) - common)].hex(" ")})
    return output


def changed_block_map(left: bytes, right: bytes, block_size: int = 256) -> dict:
    """Create a compact terminal heatmap for byte changes at matching offsets."""
    if block_size <= 0:
        raise ValueError("Change-map block size must be positive.")
    common = min(len(left), len(right))
    blocks = []
    levels = " .:-=+*#%@"
    for start in range(0, common, block_size):
        end = min(start + block_size, common)
        changed = sum(1 for offset in range(start, end) if left[offset] != right[offset])
        ratio = changed / max(1, end - start)
        level = min(len(levels) - 1, int(ratio * (len(levels) - 1)))
        blocks.append({"start": start, "endExclusive": end, "changedBytes": changed,
                       "comparedBytes": end - start, "changeRatio": round(ratio, 5),
                       "glyph": levels[level]})
    return {"blockSize": block_size, "comparedBytes": common,
            "leftOnlyBytes": max(0, len(left) - common), "rightOnlyBytes": max(0, len(right) - common),
            "legend": "space=0%; .<10%; :<20%; -<30%; =<40%; +<50%; *<60%; #<70%; %<80%; @>=80%",
            "heatmap": "".join(block["glyph"] for block in blocks), "blocks": blocks}


def scan_floats(data: bytes, width: int, endian: str, minimum: float, maximum: float, stride: int) -> list[dict]:
    fmt = ("<" if endian == "le" else ">") + ("f" if width == 32 else "d")
    size = width // 8
    values = []
    for offset in range(0, len(data) - size + 1, stride):
        try:
            value = struct.unpack_from(fmt, data, offset)[0]
        except struct.error:
            continue
        if math.isfinite(value) and minimum <= value <= maximum:
            values.append({"offset": offset, "value": value, "hex": data[offset:offset + size].hex(" ")})
    return values


def find_integer(data: bytes, value: int, width: int, endian: str) -> list[int]:
    fmt = ("<" if endian == "le" else ">") + ({16: "H", 32: "I", 64: "Q"}[width])
    packed = struct.pack(fmt, value)
    offsets, start = [], 0
    while True:
        offset = data.find(packed, start)
        if offset < 0:
            return offsets
        offsets.append(offset)
        start = offset + 1


def correlate(manifest_path: str, top: int) -> dict:
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    rows = manifest.get("samples", [])
    if len(rows) < 3:
        raise ValueError("Correlation needs at least three independent samples.")
    blobs = [(read_file(row["file"]), row) for row in rows]
    end = min(len(blob) for blob, _ in blobs)
    metrics = ("centerX", "centerY", "width", "height")

    def pearson(xs: list[float], ys: list[float]) -> float | None:
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        dx, dy = [x - mx for x in xs], [y - my for y in ys]
        denom = math.sqrt(sum(x*x for x in dx) * sum(y*y for y in dy))
        return sum(x*y for x, y in zip(dx, dy)) / denom if denom else None

    scores = {name: [] for name in metrics}
    for offset in range(end):
        byte_values = [float(blob[offset]) for blob, _ in blobs]
        for name in metrics:
            points = [row.get(name) for _, row in blobs]
            if all(isinstance(value, (int, float)) for value in points):
                score = pearson(byte_values, [float(value) for value in points])
                if score is not None:
                    scores[name].append({"offset": offset, "r": round(score, 6)})
    ranked = {name: sorted(rows, key=lambda item: abs(item["r"]), reverse=True)[:top]
              for name, rows in scores.items()}
    return {"samples": len(rows), "sharedPrefixBytes": end, "warning": "Byte correlation is exploratory; confirm the same offset and semantics with independent controlled samples.", "topOffsets": ranked}


def inspect_project(path: str, track_item_id: str | None = None, details: bool = False) -> dict:
    raw = read_file(path)
    compressed = raw.startswith(b"\x1f\x8b")
    xml_bytes = gzip.decompress(raw) if compressed else raw
    root = ET.fromstring(xml_bytes)
    objects = {element.attrib.get("ObjectID"): element for element in root.iter() if element.attrib.get("ObjectID")}
    masks = []
    for component in root.iter("VideoFilterComponent"):
        match_name = component.findtext("MatchName")
        if match_name != "AE.ADBE AEMask2":
            continue
        private = component.find("PremiereFilterPrivateData")
        params = []
        for ref in component.iter("Param"):
            param_id = ref.attrib.get("ObjectRef")
            parameter = objects.get(param_id)
            if parameter is None:
                continue
            name = parameter.findtext("Name")
            if not name:
                continue
            start_value = parameter.findtext("StartKeyframeValue") or ""
            decoded = b""
            if start_value:
                try:
                    decoded = base64.b64decode("".join(start_value.split()), validate=False)
                except (ValueError, TypeError):
                    pass
            keyframe_element = parameter.find("Keyframes")
            keyframes = "".join(keyframe_element.itertext()) if keyframe_element is not None else ""
            blobs = []
            ticks = []
            for entry in keyframes.split(";"):
                try:
                    tick, encoded = entry.split(",", 1)
                    blobs.append(base64.b64decode("".join(encoded.split()), validate=False))
                    ticks.append(tick.strip())
                except (ValueError, TypeError):
                    continue
            uuids = re.findall(rb"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", decoded, re.I)
            parameter_summary = {"id": param_id, "name": name, "timeVarying": parameter.findtext("IsTimeVarying"),
                                 "keyCount": len(blobs), "payloadLengths": dict(Counter(len(blob) for blob in blobs)),
                                 "startValueBytes": len(decoded),
                                 "startValueUuidStrings": [value.decode("ascii", "replace") for value in uuids]}
            if details:
                parameter_summary["startValueHex"] = decoded[:128].hex(" ")
                parameter_summary["startValueText"] = decoded[:512].decode("utf8", "replace")
                if blobs:
                    first = blobs[0]
                    complete_floats = len(first) // 4
                    parameter_summary["firstKeyPayloadHex"] = first.hex(" ")
                    parameter_summary["firstKeyFloat32LE"] = [struct.unpack_from("<f", first, index * 4)[0] for index in range(complete_floats)]
                    if all(len(blob) == 104 for blob in blobs):
                        candidates = []
                        previews = []
                        for sample_index, blob in enumerate(blobs):
                            values = [struct.unpack_from("<f", blob, index * 4)[0] for index in range(26)]
                            determinant = values[1] * values[5] - values[2] * values[4]
                            candidate = math.sqrt(abs(determinant)) if math.isfinite(determinant) else None
                            candidates.append(candidate)
                            if sample_index < 8:
                                previews.append({"index": sample_index, "ticks": ticks[sample_index],
                                                 "candidateXY": [values[16], values[17]],
                                                 "candidateMatrix2x2": [values[1], values[2], values[4], values[5]],
                                                 "candidateGeometricScale": candidate})
                        valid_candidates = [value for value in candidates if value is not None and math.isfinite(value)]
                        parameter_summary["candidateAffineSummary"] = {
                            "method": "float32 little-endian 2x2 determinant at sample offsets 4, 8, 16, 20",
                            "sampleCount": len(blobs), "min": min(valid_candidates, default=None),
                            "max": max(valid_candidates, default=None), "distinctRounded": len({round(value, 5) for value in valid_candidates}),
                            "firstSamples": previews,
                            "warning": "Field meanings are hypotheses; these values have not been independently validated as Object Mask bounds or subject scale.",
                        }
            params.append(parameter_summary)
        masks.append({"objectId": component.attrib.get("ObjectID"), "instanceName": component.findtext("InstanceName"),
                      "binaryHash": private.attrib.get("BinaryHash") if private is not None else None,
                      "privateDataLength": len(private.text or "") if private is not None else 0,
                      "subcomponents": [ref.attrib.get("ObjectRef") for ref in component.iter("SubComponent")],
                      "parameters": params})
    sidecar_dir = Path(path).parent / (Path(path).stem + " Masks")
    if not sidecar_dir.is_dir():
        sidecar_dir = Path(path).parent
    sidecar_names = [item.name for item in sidecar_dir.glob("*.prmf")]
    sidecar_set = {name[:-5].lower() for name in sidecar_names}
    for mask in masks:
        for parameter in mask["parameters"]:
            parameter["sidecarMatches"] = [uuid for uuid in parameter["startValueUuidStrings"] if uuid.lower() in sidecar_set]
    project_guids = sorted({guid.lower() for mask in masks for parameter in mask["parameters"] for guid in parameter["startValueUuidStrings"]})
    sidecar_content_matches = []
    for filename in sidecar_names:
        sidecar_data = (sidecar_dir / filename).read_bytes()
        matches = []
        for guid_text in project_guids:
            try:
                guid = uuidlib.UUID(guid_text)
            except ValueError:
                continue
            if any(candidate in sidecar_data for candidate in (guid_text.encode("ascii"), guid.bytes, guid.bytes_le)):
                matches.append(guid_text)
        own_guid = filename[:-5].lower()
        try:
            file_guid = uuidlib.UUID(own_guid)
            own_name_in_data = any(candidate in sidecar_data for candidate in (own_guid.encode("ascii"), file_guid.bytes, file_guid.bytes_le))
        except ValueError:
            own_name_in_data = False
        sidecar_content_matches.append({"file": filename, "projectGuidsFoundInBody": matches, "filenameGuidFoundInBody": own_name_in_data})
    component_elements = {element.attrib.get("ObjectID"): element for element in root.iter("VideoFilterComponent") if element.attrib.get("ObjectID")}
    item_records = []
    for item in root.iter("VideoClipTrackItem"):
        item_id = (item.findtext("./ClipTrackItem/TrackItem/Node/ID")
                   or item.findtext(".//Node/ID") or item.attrib.get("ObjectID"))
        selection = item.find("SelectionComponents")
        chain_id = selection.attrib.get("ObjectRef") if selection is not None else None
        chain = objects.get(chain_id)
        refs = [ref.attrib.get("ObjectRef") for ref in chain.iter("Component")] if chain is not None else []
        roots = []
        for ref in refs:
            component = component_elements.get(ref)
            if component is None or component.findtext("MatchName") != "AE.ADBE AEMask2":
                continue
            subtree_ids = [ref] + [entry.attrib.get("ObjectRef") for entry in component.iter("SubComponent")]
            tracker_info = []
            for subtree_id in subtree_ids:
                mask = next((candidate for candidate in masks if candidate["objectId"] == subtree_id), None)
                if mask is None:
                    continue
                for parameter in mask["parameters"]:
                    if parameter["name"].lower() == "tracker":
                        tracker_info.append({"parameterId": parameter["id"], "keyCount": parameter["keyCount"],
                                             "payloadLengths": parameter["payloadLengths"],
                                             "startValueUuidStrings": parameter["startValueUuidStrings"],
                                             "sidecarMatches": parameter["sidecarMatches"]})
            roots.append({"componentId": ref, "binaryHash": next((mask["binaryHash"] for mask in masks if mask["objectId"] == ref), None),
                          "subcomponentIds": subtree_ids[1:], "trackerParameters": tracker_info})
        if roots and (track_item_id is None or item_id == str(track_item_id)):
            item_records.append({"trackItemId": item_id, "nodeObjectId": item.attrib.get("ObjectID"),
                                 "selectionChainId": chain_id, "aemask2Roots": roots})
    referenced = []
    xml_lower = xml_bytes.lower()
    for name in sidecar_names:
        uuid = name[:-5]
        guid_bytes = bytes.fromhex(uuid.replace("-", ""))
        guid_mixed = bytes.fromhex(uuid[6:8] + uuid[4:6] + uuid[2:4] + uuid[0:2] + uuid[11:13] + uuid[9:11] + uuid[16:18] + uuid[14:16] + uuid[19:23] + uuid[24:36])
        referenced.append({"file": name, "textUuidFound": uuid.lower().encode("ascii") in xml_lower,
                           "rawUuidFound": guid_bytes in xml_bytes,
                           "windowsGuidByteOrderFound": guid_mixed in xml_bytes})
    return {"path": str(Path(path).resolve()), "compressedGzip": compressed, "projectBytes": len(raw),
            "xmlBytes": len(xml_bytes), "rootTag": root.tag, "aemask2Components": masks,
            "maskFolder": str(sidecar_dir.resolve()), "sidecarNames": sidecar_names,
            "sidecarUuidReferences": referenced, "sidecarContentMatches": sidecar_content_matches,
            "projectTrackerGuids": project_guids, "trackItemsWithAemask2": item_records}


def inspect_prmf_header(path: str) -> dict:
    data = read_file(path)
    if len(data) < 32:
        raise ValueError("File is shorter than the observed 32-byte PRMF header.")
    magic, version, payload_end, reserved = struct.unpack_from("<4sIII", data, 0)
    trailer_bytes, payload_start = struct.unpack_from("<QQ", data, 16)
    if payload_start < 32 or payload_end < payload_start or payload_end > len(data):
        raise ValueError("The PRMF payload bounds are invalid.")
    trailer_offset = payload_end
    trailer = data[trailer_offset:]
    payload = data[payload_start:payload_end]
    trailer_length_matches = trailer_bytes == len(trailer)
    return {
        "path": str(Path(path).resolve()), "magic": magic.decode("ascii", "replace"), "version": version,
        "fileBytes": len(data), "headerBytes": 32, "reservedU32": reserved,
        "payloadEndOffset": payload_end, "payloadStartOffset": payload_start,
        "payloadBytes": len(payload), "payloadEntropy": round(shannon_entropy(payload), 5),
        "trailerOffset": trailer_offset, "trailerBytesDeclared": trailer_bytes,
        "trailerBytesActual": len(trailer), "trailerLengthMatchesFileEnd": trailer_length_matches,
        "trailerEntropy": round(shannon_entropy(trailer), 5),
        "layout": "Observed v3 layout: 32-byte header, frame-payload region [payloadStartOffset,payloadEndOffset), then trailer bytes to EOF.",
        "hypothesis": "The trailer contains a FlatBuffers-style frame index; record meanings require controlled validation.",
    }


def _prmf_layout(data: bytes) -> dict:
    if len(data) < 32 or data[:4] != b"prmf":
        return {"valid": False, "payloadStart": 0, "payloadEnd": 0, "trailerOffset": 0, "trailerBytes": 0}
    payload_end = struct.unpack_from("<I", data, 8)[0]
    trailer_bytes, payload_start = struct.unpack_from("<QQ", data, 16)
    valid = (32 <= payload_start <= payload_end <= len(data)
             and payload_end + trailer_bytes == len(data))
    return {"valid": valid, "payloadStart": payload_start, "payloadEnd": payload_end,
            "payloadBytes": max(0, payload_end - payload_start), "trailerOffset": payload_end,
            "trailerBytes": trailer_bytes}


def _flatbuffer_table_layout(data: bytes, table: int, lower_bound: int, upper_bound: int) -> dict | None:
    if table < lower_bound + 4 or table + 4 > upper_bound:
        return None
    vtable_distance = struct.unpack_from("<i", data, table)[0]
    if vtable_distance == 0:
        return None
    vtable = table - vtable_distance
    if vtable < lower_bound or vtable + 4 > upper_bound:
        return None
    vtable_bytes, object_bytes = struct.unpack_from("<HH", data, vtable)
    if (vtable_bytes < 4 or vtable_bytes % 2 or object_bytes < 4
            or vtable + vtable_bytes > upper_bound or table + object_bytes > upper_bound):
        return None
    fields = struct.unpack_from("<%dH" % ((vtable_bytes - 4) // 2), data, vtable + 4) if vtable_bytes > 4 else ()
    if any(field and (field < 4 or field >= object_bytes) for field in fields):
        return None
    return {"tableOffset": table, "vtableOffset": vtable, "vtableBytes": vtable_bytes,
            "objectBytes": object_bytes, "fields": fields}


def decode_prmf_v3_candidate_geometry(path: str) -> dict:
    """Extract the observed v3 frame-rectangle records as explicitly unvalidated candidates."""
    data = read_file(path)
    layout = _prmf_layout(data)
    if not layout["valid"]:
        raise ValueError("The file does not match the observed PRMF v3 header bounds.")
    if struct.unpack_from("<I", data, 4)[0] != 3:
        raise ValueError("Only the observed PRMF v3 sidecar layout is supported.")

    footer_start, footer_end = layout["trailerOffset"], len(data)
    if footer_start + 4 > footer_end:
        raise ValueError("The PRMF trailer is too short for a root table offset.")
    root_table = footer_start + struct.unpack_from("<I", data, footer_start)[0]
    root = _flatbuffer_table_layout(data, root_table, footer_start, footer_end)
    if not root or root["fields"] != (12, 8, 4) or root["objectBytes"] < 16:
        raise ValueError("The PRMF trailer root does not match the observed frame-index table shape.")
    if struct.unpack_from("<I", data, root_table + root["fields"][0])[0] != 3:
        raise ValueError("The PRMF frame-index table version field is not 3.")

    config_pointer = root_table + root["fields"][1]
    config_table = config_pointer + struct.unpack_from("<I", data, config_pointer)[0]
    config = _flatbuffer_table_layout(data, config_table, footer_start, footer_end)
    if not config or config["fields"] != (8, 6, 7):
        raise ValueError("The PRMF trailer configuration table does not match the observed layout.")

    vector_pointer = root_table + root["fields"][2]
    vector = vector_pointer + struct.unpack_from("<I", data, vector_pointer)[0]
    if vector < footer_start or vector + 4 > footer_end:
        raise ValueError("The PRMF frame vector is outside the trailer.")
    frame_count = struct.unpack_from("<I", data, vector)[0]
    if frame_count == 0 or frame_count > 1_000_000 or vector + 4 + frame_count * 4 > footer_end:
        raise ValueError("The PRMF frame vector count or bounds are invalid.")

    frames = []
    for vector_index in range(frame_count):
        element = vector + 4 + vector_index * 4
        table = element + struct.unpack_from("<I", data, element)[0]
        record = _flatbuffer_table_layout(data, table, footer_start, footer_end)
        supported_record_shapes = {
            (4, 36, 44, 8, 24, 0, 32),
            (4, 0, 36, 8, 24, 0, 32),
        }
        if not record or record["fields"] not in supported_record_shapes:
            raise ValueError(f"Frame record {vector_index} does not match the observed seven-slot table.")
        fields = record["fields"]
        time_ticks = struct.unpack_from("<Q", data, table + fields[1])[0] if fields[1] else None
        payload_offset = struct.unpack_from("<Q", data, table + fields[2])[0]
        x, y, width, height = struct.unpack_from("<4I", data, table + fields[3])
        source_width, source_height = struct.unpack_from("<2I", data, table + fields[4])
        payload_bytes = struct.unpack_from("<I", data, table + fields[6])[0]
        if (not source_width or not source_height or not width or not height
                or x + width > source_width or y + height > source_height):
            raise ValueError(f"Frame record {vector_index} has implausible geometry or dimensions.")
        if payload_offset < layout["payloadStart"] or payload_bytes == 0 or payload_offset + payload_bytes > layout["payloadEnd"]:
            raise ValueError(f"Frame record {vector_index} points outside the PRMF payload region.")
        frames.append({"vectorIndex": vector_index, "timeTicks": time_ticks,
                       "time": time_ticks / PREMIERE_TICKS_PER_SECOND if time_ticks is not None else None,
                       "timeStored": time_ticks is not None,
                       "payloadOffset": payload_offset, "payloadBytes": payload_bytes,
                       "x": x, "y": y, "width": width, "height": height,
                       "sourceWidth": source_width, "sourceHeight": source_height})

    by_payload = sorted(frames, key=lambda frame: frame["payloadOffset"])
    cursor = layout["payloadStart"]
    for frame in by_payload:
        if frame["payloadOffset"] != cursor:
            raise ValueError("Per-frame payload ranges have a gap or overlap; refusing candidate geometry output.")
        cursor += frame["payloadBytes"]
    if cursor != layout["payloadEnd"]:
        raise ValueError("Per-frame payload ranges do not cover the declared payload region.")

    stored_frames = [frame for frame in by_payload if frame["timeTicks"] is not None]
    by_time = sorted(stored_frames, key=lambda frame: frame["timeTicks"])
    time_steps = [right["timeTicks"] - left["timeTicks"] for left, right in zip(by_time, by_time[1:])]
    if any(step <= 0 for step in time_steps):
        raise ValueError("Stored per-frame timestamps are not strictly increasing.")
    if any(left["timeTicks"] >= right["timeTicks"]
           for left, right in zip(stored_frames, stored_frames[1:])):
        raise ValueError("Stored frame timestamps and payload order disagree.")

    candidate_frames = []
    for frame_number, frame in enumerate(by_payload):
        center_x = frame["x"] + frame["width"] / 2
        center_y = frame["y"] + frame["height"] / 2
        candidate_frames.append({
            "frame": frame_number,
            "vectorIndex": frame["vectorIndex"],
            "time": frame["time"],
            "centerX": center_x,
            "centerY": center_y,
            "left": frame["x"],
            "top": frame["y"],
            "right": frame["x"] + frame["width"],
            "bottom": frame["y"] + frame["height"],
            "x": frame["x"],
            "y": frame["y"],
            "width": frame["width"],
            "height": frame["height"],
            "normalizedCenterX": center_x / frame["sourceWidth"],
            "normalizedCenterY": center_y / frame["sourceHeight"],
            "normalizedWidth": frame["width"] / frame["sourceWidth"],
            "normalizedHeight": frame["height"] / frame["sourceHeight"],
            "centerXNormalized": center_x / frame["sourceWidth"],
            "centerYNormalized": center_y / frame["sourceHeight"],
            "widthNormalized": frame["width"] / frame["sourceWidth"],
            "heightNormalized": frame["height"] / frame["sourceHeight"],
            "timeTicks": frame["timeTicks"],
            "timeStored": frame["timeStored"],
            "timeInference": None,
            "payloadOffset": frame["payloadOffset"],
            "payloadBytes": frame["payloadBytes"],
            "sourceWidth": frame["sourceWidth"],
            "sourceHeight": frame["sourceHeight"],
            "sourceSidecarUuid": Path(path).stem,
            "sourceFile": Path(path).name,
        })
    return {
        "path": str(Path(path).resolve()), "fileBytes": len(data),
        "layout": {"payloadStart": layout["payloadStart"], "payloadEnd": layout["payloadEnd"],
                   "payloadBytes": layout["payloadBytes"], "trailerOffset": footer_start,
                   "trailerBytes": layout["trailerBytes"]},
        "frameCount": len(candidate_frames),
        "payloadRangesExactlyCoverPayload": True,
        "frameTimeDeltasTicks": sorted(set(time_steps)),
        "storedTimestampCount": len(stored_frames),
        "missingTimestampFrameIndexes": [frame["vectorIndex"] for frame in frames if frame["timeTicks"] is None],
        "candidateFrames": candidate_frames,
        "extractionConfidence": "candidate-geometry-needs-controlled-validation",
        "validation": {"recordLayoutAndPayloadCoverage": "passed",
                       "timestampsMonotonicAndPayloadOrdered": "passed",
                       "controlledMotionAndScaleSamples": "not supplied",
                       "pluginIntegrationAllowed": False},
    }


def assign_missing_project_frame_times(sidecars: list[dict], expected_time_ticks: list[int] | None) -> None:
    """Snap stable sub-frame timestamps and fill omitted slots from a proven frame-index offset."""
    missing_frames = [frame for sidecar in sidecars for frame in sidecar["candidateFrames"]
                      if frame["timeTicks"] is None]
    if expected_time_ticks is None:
        if not missing_frames:
            return
        raise ValueError("Some PRMF records omit timestamps; supply the saved project timing to map their frame indexes.")
    expected = [int(value) for value in expected_time_ticks]
    expected_index = {ticks: index for index, ticks in enumerate(expected)}
    if len(expected_index) != len(expected) or len(expected) < 2:
        raise ValueError("Project timing contains duplicate expected timestamps.")
    frame_duration = expected[1] - expected[0]
    if frame_duration <= 0 or any(right - left != frame_duration for left, right in zip(expected, expected[1:])):
        raise ValueError("Project timing does not contain one constant source-frame interval.")

    sidecar_offsets: dict[str, int] = {}
    observed_offsets = set()
    for sidecar in sidecars:
        offsets = set()
        residuals = []
        for frame in sidecar["candidateFrames"]:
            frame.setdefault("payloadIndex", frame["frame"])
            if frame["timeTicks"] is None:
                continue
            source_ticks = int(frame["timeTicks"])
            relative = (source_ticks - expected[0]) / frame_duration
            frame_index = math.floor(relative + 0.5)
            residual = relative - frame_index
            if abs(residual) > 0.5 - 1e-7:
                raise ValueError(f"Stored PRMF timestamp {frame['timeTicks']} is outside the project frame-time grid.")
            if frame_index < 0 or frame_index >= len(expected):
                raise ValueError(f"Stored PRMF timestamp {frame['timeTicks']} maps outside the project source range.")
            residuals.append(residual)
            frame["sourceTimeTicks"] = source_ticks
            frame["timeGridOffsetFrames"] = residual
            frame["frame"] = frame_index
            frame["timeTicks"] = expected[frame_index]
            frame["time"] = frame["timeTicks"] / PREMIERE_TICKS_PER_SECOND
            offsets.add(frame_index - frame["payloadIndex"])
        if residuals and max(residuals) - min(residuals) > 0.05:
            raise ValueError(f"Stored PRMF timestamps in {Path(sidecar['path']).name} do not share a stable sub-frame offset.")
        if len(offsets) > 1:
            raise ValueError(f"Stored timestamps in {Path(sidecar['path']).name} do not align to a constant frame-index offset.")
        if offsets:
            offset = next(iter(offsets))
            sidecar_offsets[sidecar["path"]] = offset
            observed_offsets.add(offset)

    for sidecar in sidecars:
        frames = sidecar["candidateFrames"]
        if not any(frame["timeTicks"] is None for frame in frames):
            continue
        offset = sidecar_offsets.get(sidecar["path"])
        inference_basis = "same-sidecar stored timestamp/frame indexes"
        if offset is None:
            if len(observed_offsets) != 1:
                raise ValueError(f"Cannot infer omitted timestamps in {Path(sidecar['path']).name}: other sidecars do not establish one frame-index offset.")
            offset = next(iter(observed_offsets))
            inference_basis = "offset corroborated by another referenced sidecar's stored timestamps"
        for frame in frames:
            expected_index_value = frame["payloadIndex"] + offset
            if expected_index_value < 0 or expected_index_value >= len(expected):
                raise ValueError(f"PRMF frame in {Path(sidecar['path']).name} maps outside the project frame interval.")
            if frame["timeTicks"] is None:
                frame["timeTicks"] = expected[expected_index_value]
                frame["time"] = frame["timeTicks"] / PREMIERE_TICKS_PER_SECOND
                frame["frame"] = expected_index_value
                frame["timeInference"] = inference_basis
            elif expected_index_value != frame["frame"]:
                raise ValueError(f"Stored timestamp in {Path(sidecar['path']).name} contradicts its inferred frame index.")
        sidecar["validation"]["omittedTimestampsResolvedFromProjectTiming"] = True
        sidecar["validation"]["timeInferenceBasis"] = inference_basis


def _temporal_frame_sidecars(sidecars: list[dict]) -> tuple[list[dict], list[dict]]:
    """Separate timestamped/multi-frame streams from untimed singleton references."""
    temporal = [sidecar for sidecar in sidecars
                if sidecar["frameCount"] > 1 or sidecar["storedTimestampCount"] > 0]
    untimed_singletons = [sidecar for sidecar in sidecars
                          if sidecar["frameCount"] == 1 and sidecar["storedTimestampCount"] == 0]
    return temporal, untimed_singletons


def project_track_timing(path: str, track_item_id: str) -> dict:
    raw = read_file(path)
    xml_bytes = gzip.decompress(raw) if raw.startswith(b"\x1f\x8b") else raw
    root = ET.fromstring(xml_bytes)
    objects = {element.attrib.get("ObjectID"): element for element in root.iter()
               if element.attrib.get("ObjectID")}
    item = next((element for element in root.iter("VideoClipTrackItem")
                 if element.findtext(".//ID") == str(track_item_id)
                 or element.attrib.get("ObjectID") == str(track_item_id)), None)
    if item is None:
        raise ValueError(f"TrackItem {track_item_id} was not found in the saved Premiere project.")
    subclip_ref = item.find("./ClipTrackItem/SubClip")
    subclip = objects.get(subclip_ref.attrib.get("ObjectRef")) if subclip_ref is not None else None
    clip_ref = subclip.find("Clip") if subclip is not None else None
    clip = objects.get(clip_ref.attrib.get("ObjectRef")) if clip_ref is not None else None
    if clip is None:
        raise ValueError(f"TrackItem {track_item_id} does not resolve to a source VideoClip.")
    in_point_text = clip.findtext("./Clip/InPoint")
    out_point_text = clip.findtext("./Clip/OutPoint")
    if in_point_text is None or out_point_text is None:
        raise ValueError(f"TrackItem {track_item_id} source clip has no saved in/out points.")
    clip_name = (subclip.findtext("Name") if subclip is not None else None) or clip.findtext("Name")
    rates = {int(element.findtext("MediaFrameRate")) for element in root.iter("ClipLoggingInfo")
             if element.findtext("ClipName") == clip_name and element.findtext("MediaFrameRate")}
    if len(rates) != 1:
        raise ValueError(f"Could not resolve one MediaFrameRate for source clip {clip_name!r}.")
    in_point, out_point = int(in_point_text), int(out_point_text)
    frame_duration = next(iter(rates))
    if out_point <= in_point or frame_duration <= 0:
        raise ValueError("The saved source clip range or MediaFrameRate is invalid.")
    duration = out_point - in_point
    expected_count = (duration + frame_duration - 1) // frame_duration
    return {"trackItemId": str(track_item_id), "clipName": clip_name,
            "inPointTicks": in_point, "outPointTicks": out_point,
            "frameDurationTicks": frame_duration, "expectedSampleCount": expected_count,
            "expectedTimes": list(range(in_point, out_point, frame_duration))}


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2


def geometry_scale_ratio(reference: dict, current: dict) -> float:
    """Return graphic-follow scale ratio from two positive rectangle geometries."""
    def dimensions(rectangle: dict) -> tuple[float, float]:
        left, top = float(rectangle.get("left", rectangle.get("x", 0))), float(rectangle.get("top", rectangle.get("y", 0)))
        right = float(rectangle["right"]) if "right" in rectangle else left + float(rectangle["width"])
        bottom = float(rectangle["bottom"]) if "bottom" in rectangle else top + float(rectangle["height"])
        return right - left, bottom - top
    reference_width, reference_height = dimensions(reference)
    current_width, current_height = dimensions(current)
    if min(reference_width, reference_height, current_width, current_height) <= 0:
        raise ValueError("Scale ratio requires positive reference and current rectangle dimensions.")
    return math.sqrt((current_width / reference_width) * (current_height / reference_height))


def canonical_rectangle_timeline(records: list[dict], conflict_tolerance_px: float = 5,
                                 expected_time_ticks: list[int] | None = None) -> dict:
    """Merge rectangle candidates by Premiere ticks, retaining every observation."""
    if conflict_tolerance_px < 0:
        raise ValueError("Duplicate conflict tolerance must be non-negative.")
    by_time: dict[int, list[dict]] = {}
    for source_record in records:
        ticks = int(source_record["timeTicks"])
        left = float(source_record.get("left", source_record.get("x", 0)))
        top = float(source_record.get("top", source_record.get("y", 0)))
        right = float(source_record["right"]) if "right" in source_record else left + float(source_record["width"])
        bottom = float(source_record["bottom"]) if "bottom" in source_record else top + float(source_record["height"])
        if right <= left or bottom <= top:
            raise ValueError(f"Rectangle at {ticks} ticks has non-positive dimensions.")
        observation = {
            "sourceSidecarUuid": source_record.get("sourceSidecarUuid") or source_record.get("sourceUuid"),
            "file": source_record.get("sourceFile") or source_record.get("file"),
            "sourceFrame": source_record.get("frame"),
            "box": [left, top, right - left, bottom - top],
            "rectangle": [left, top, right, bottom],
            "left": left, "top": top, "right": right, "bottom": bottom,
            "sourceWidth": int(source_record["sourceWidth"]),
            "sourceHeight": int(source_record["sourceHeight"]),
        }
        if source_record.get("payloadOffset") is not None:
            observation["payloadOffset"] = source_record["payloadOffset"]
            observation["payloadBytes"] = source_record.get("payloadBytes")
        by_time.setdefault(ticks, []).append(observation)

    expected = sorted(set(int(value) for value in expected_time_ticks)) if expected_time_ticks is not None else None
    expected_frame_by_time = {ticks: frame for frame, ticks in enumerate(expected or [])}
    timeline = []
    duplicate_times = []
    max_disagreement = 0.0
    exact_duplicate_record_count = 0
    near_duplicate_time_count = 0
    large_conflict_time_count = 0
    total_record_count = len(records)

    for ordinal, (ticks, observations) in enumerate(sorted(by_time.items())):
        unique = {}
        for observation in observations:
            key = (tuple(observation["rectangle"]), observation["sourceWidth"], observation["sourceHeight"])
            unique.setdefault(key, observation)
        unique_observations = list(unique.values())
        exact_removed = len(observations) - len(unique_observations)
        exact_duplicate_record_count += exact_removed
        coordinates = list(zip(*(item["rectangle"] for item in observations)))
        disagreement = max((max(axis) - min(axis) for axis in coordinates), default=0.0)
        max_disagreement = max(max_disagreement, disagreement)
        dimensions_agree = len({(item["sourceWidth"], item["sourceHeight"]) for item in observations}) == 1
        if len(unique_observations) == 1:
            classification = "exact-duplicate" if len(observations) > 1 else "single"
            chosen = list(unique_observations[0]["rectangle"])
            resolved = True
        elif dimensions_agree and disagreement <= conflict_tolerance_px:
            classification = "near-duplicate"
            # Exact records were collapsed above; each distinct observed rectangle
            # therefore contributes once to the coordinate-wise median.
            chosen = [_median([item["rectangle"][axis] for item in unique_observations]) for axis in range(4)]
            near_duplicate_time_count += 1
            resolved = True
        else:
            classification = "large-conflict"
            chosen = None
            large_conflict_time_count += 1
            resolved = False

        if len(observations) > 1:
            duplicate_times.append({
                "timeTicks": ticks,
                "frame": expected_frame_by_time.get(ticks, ordinal),
                "classification": classification,
                "observationCount": len(observations),
                "distinctRectangleCount": len(unique_observations),
                "exactDuplicateRecordCount": exact_removed,
                "maximumCoordinateDisagreementPx": disagreement,
                "conflictTolerancePx": conflict_tolerance_px,
                "geometryAgrees": classification == "exact-duplicate",
                "observations": observations,
            })

        source_width = observations[0]["sourceWidth"] if dimensions_agree else None
        source_height = observations[0]["sourceHeight"] if dimensions_agree else None
        if chosen is not None:
            left, top, right, bottom = chosen
            width, height = right - left, bottom - top
            center_x, center_y = (left + right) / 2, (top + bottom) / 2
        else:
            left = top = right = bottom = width = height = center_x = center_y = None
        frame_index = expected_frame_by_time.get(ticks, ordinal)
        source_uuids = sorted({item["sourceSidecarUuid"] for item in observations if item["sourceSidecarUuid"]})
        normalized_center_x = center_x / source_width if center_x is not None and source_width else None
        normalized_center_y = center_y / source_height if center_y is not None and source_height else None
        normalized_width = width / source_width if width is not None and source_width else None
        normalized_height = height / source_height if height is not None and source_height else None
        timeline.append({
            "frame": frame_index,
            "frameIndex": frame_index,
            "time": ticks / PREMIERE_TICKS_PER_SECOND,
            "timeTicks": ticks,
            "left": left, "top": top, "right": right, "bottom": bottom,
            "x": left, "y": top,
            "centerX": center_x, "centerY": center_y,
            "width": width, "height": height,
            "normalizedCenterX": normalized_center_x,
            "normalizedCenterY": normalized_center_y,
            "normalizedWidth": normalized_width,
            "normalizedHeight": normalized_height,
            "centerXNormalized": normalized_center_x,
            "centerYNormalized": normalized_center_y,
            "widthNormalized": normalized_width,
            "heightNormalized": normalized_height,
            "sourceWidth": source_width,
            "sourceHeight": source_height,
            "sourceSidecarUuid": source_uuids[0] if len(source_uuids) == 1 else None,
            "sourceSidecarUuids": source_uuids,
            "duplicateClassification": classification,
            "duplicateCount": max(0, len(observations) - 1),
            "exactDuplicateRecordCount": exact_removed,
            "maximumCoordinateDisagreementPx": disagreement,
            "conflictTolerancePx": conflict_tolerance_px,
            "conflict": not resolved,
            "ambiguousDuplicate": not resolved,
            "geometryCandidates": [item["box"] for item in observations] if not resolved else None,
            "sources": observations,
        })

    observed = sorted(by_time)
    missing = [ticks for ticks in expected or [] if ticks not in by_time]
    unexpected = [ticks for ticks in observed if expected is not None and ticks not in expected_frame_by_time]
    return {
        "recordCount": total_record_count,
        "uniqueTimeCount": len(timeline),
        "duplicateTimeCount": len(duplicate_times),
        "duplicateGeometryAgreementCount": sum(1 for item in duplicate_times if item["classification"] == "exact-duplicate"),
        "duplicateGeometryConflictCount": large_conflict_time_count,
        "duplicateRecordCount": max(0, total_record_count - len(timeline)),
        "exactDuplicateRecordCount": exact_duplicate_record_count,
        "nearDuplicateTimeCount": near_duplicate_time_count,
        "largeConflictTimeCount": large_conflict_time_count,
        "maximumDuplicateCoordinateDisagreementPx": max_disagreement,
        "conflictTolerancePx": conflict_tolerance_px,
        "duplicateTimes": duplicate_times,
        "candidateTimeline": timeline,
        "candidateTimelineAmbiguousCount": sum(1 for item in timeline if item["conflict"]),
        "timestampsStrictlyIncreasing": all(a < b for a, b in zip(observed, observed[1:])),
        "timestampsStrictlyIncreasingWithinEachSidecar": True,
        "timelineCoverage": {
            "expectedFrameCount": len(expected) if expected is not None else None,
            "observedUniqueTimeCount": len(observed),
            "missingFrameCount": len(missing),
            "missingTimeTicks": missing,
            "unexpectedFrameCount": len(unexpected),
            "unexpectedTimeTicks": unexpected,
            "complete": expected is not None and not missing and not unexpected,
            "coverageRatio": (len(expected) - len(missing)) / len(expected) if expected else None,
        },
    }


def candidate_geometry_report(paths: list[str], project_path: str | None = None,
                              track_item_id: str | None = None,
                              conflict_tolerance_px: float = 5,
                              expected_time_ticks: list[int] | None = None) -> dict:
    if project_path or track_item_id:
        if not project_path or not track_item_id:
            raise ValueError("--project and --track-item-id must be supplied together.")
        timing = project_track_timing(project_path, track_item_id)
        project_report = inspect_project(project_path, track_item_id)
        target_items = [item for item in project_report["trackItemsWithAemask2"]
                        if item["trackItemId"] == str(track_item_id)]
        if len(target_items) != 1:
            raise ValueError(f"TrackItem {track_item_id} did not resolve uniquely for Tracker UUID mapping.")
        tracker_uuid_tokens = sorted({uuid_text.lower()
                                      for root in target_items[0]["aemask2Roots"]
                                      for tracker in root["trackerParameters"]
                                      for uuid_text in tracker.get("startValueUuidStrings", [])})
        tracker_uuids = sorted({uuid_text.lower()
                                for root in target_items[0]["aemask2Roots"]
                                for tracker in root["trackerParameters"]
                                for uuid_text in tracker.get("sidecarMatches", [])})
        if not tracker_uuids:
            raise ValueError(f"TrackItem {track_item_id} has no Tracker UUID sidecar references.")
        provided_uuids = {Path(item).stem.lower() for item in paths}
        unresolved_uuids = [value for value in tracker_uuids if value not in provided_uuids]
        if unresolved_uuids:
            raise ValueError(f"Candidate inputs omit Tracker UUID sidecars: {unresolved_uuids}.")
        if expected_time_ticks is not None and list(expected_time_ticks) != timing["expectedTimes"]:
            raise ValueError("Explicit expected times disagree with the saved project timing.")
        expected_times = timing["expectedTimes"]
    else:
        timing = None
        expected_times = expected_time_ticks
    sidecars = [decode_prmf_v3_candidate_geometry(path) for path in paths]
    temporal_sidecars, untimed_singletons = _temporal_frame_sidecars(sidecars)
    assign_missing_project_frame_times(temporal_sidecars, expected_times)
    records = [frame for sidecar in temporal_sidecars for frame in sidecar["candidateFrames"]]
    merged = canonical_rectangle_timeline(records, conflict_tolerance_px, expected_times)
    result = {"sidecars": sidecars,
              "crossSidecar": {key: value for key, value in merged.items()
                               if key != "recordCount"}}
    if timing:
        observed_times = sorted({int(frame["timeTicks"]) for frame in records})
        expected_set = set(expected_times)
        observed_steps = [right - left for left, right in zip(observed_times, observed_times[1:])]
        result["projectTimingCheck"] = {
            "project": str(Path(project_path).resolve()),
            "reference": {key: value for key, value in timing.items() if key != "expectedTimes"},
            "observedUniqueTimeCount": len(observed_times),
            "observedFirstTimeTicks": observed_times[0] if observed_times else None,
            "observedLastTimeTicks": observed_times[-1] if observed_times else None,
            "expectedFirstTimeTicks": expected_times[0] if expected_times else None,
            "expectedLastTimeTicks": expected_times[-1] if expected_times else None,
            "allExpectedFrameTimesPresent": all(value in set(observed_times) for value in expected_times),
            "missingFrameTimes": [value for value in expected_times if value not in set(observed_times)],
            "unexpectedFrameTimes": [value for value in observed_times if value not in expected_set],
            "frameCountMatchesTrackedDuration": len(observed_times) == timing["expectedSampleCount"],
            "allObservedDeltasMatchMediaFrameRate": all(step == timing["frameDurationTicks"] for step in observed_steps),
        }
        result["trackerSidecarResolution"] = {
            "project": str(Path(project_path).resolve()),
            "trackItemId": str(track_item_id),
            "referencedTrackerUuids": tracker_uuids,
            "trackerUuidTokensWithoutSidecarMatch": [value for value in tracker_uuid_tokens if value not in tracker_uuids],
            "matchedInputUuids": [value for value in tracker_uuids if value in provided_uuids],
            "unreferencedInputUuids": sorted(provided_uuids - set(tracker_uuids)),
            "allReferencesResolved": not unresolved_uuids,
        }
    result["untimedSingleRecordReferences"] = [
        {"uuid": Path(sidecar["path"]).stem,
         "file": Path(sidecar["path"]).name,
         "recordCount": sidecar["frameCount"],
         "reasonExcludedFromTimeline": "single candidate record has no stored timestamp; retained separately rather than assigning an arbitrary frame time",
         "candidateFrames": sidecar["candidateFrames"]}
        for sidecar in untimed_singletons
    ]
    all_candidate_records = [frame for sidecar in sidecars for frame in sidecar["candidateFrames"]]
    dimensions = sorted({(frame["sourceWidth"], frame["sourceHeight"])
                         for frame in all_candidate_records})
    result["diagnostics"] = {
        "prmfVersion": 3,
        "sidecarCount": len(sidecars),
        "candidateRecordCount": len(all_candidate_records),
        "temporalRecordCount": len(records),
        "untimedSingleRecordReferenceCount": sum(sidecar["frameCount"] for sidecar in untimed_singletons),
        "candidateFrameCount": merged["uniqueTimeCount"],
        "productionDecodedFrameCount": 0,
        "duplicateTimestampCount": merged["duplicateTimeCount"],
        "maximumDuplicateDisagreementPx": merged["maximumDuplicateCoordinateDisagreementPx"],
        "sourceDimensions": [{"width": width, "height": height} for width, height in dimensions],
        "timelineCoverage": merged["timelineCoverage"],
        "validationStatus": "candidate-only; controlled motion and scale samples are required",
        "productionIntegrationAllowed": False,
    }
    result["crossSidecar"]["recordCount"] = merged["recordCount"]
    result["validationBoundary"] = {
        "geometryFields": "candidate rectangles visually checked on three source frames; field semantics still require controlled samples",
        "timestamps": "candidate ticks align to source clip InPoint and MediaFrameRate when project timing is supplied",
        "controlledHorizontalVerticalAndScaleUpDownTests": "not supplied",
        "productionDecoderEnabled": False,
    }
    return result


CONTROL_BEHAVIORS = {"static", "horizontal", "vertical", "scale-up", "scale-down"}
DEFAULT_CONTROL_THRESHOLDS = {
    "staticCenterTolerancePx": 3.0,
    "staticSizeTolerancePx": 3.0,
    "stationaryAxisTolerancePx": 3.0,
    "stationarySizeTolerancePx": 3.0,
    "minimumMotionPx": 10.0,
    "minimumScaleChangeRatio": 1.10,
    "scaleMonotonicFraction": 0.8,
    "monotonicStepTolerancePx": 1.0,
}


def _spread(values: list[float]) -> float | None:
    return max(values) - min(values) if values else None


def _trend_fraction(values: list[float], direction: str, tolerance: float) -> float | None:
    deltas = [right - left for left, right in zip(values, values[1:])]
    if not deltas:
        return None
    if direction == "up":
        compliant = sum(delta >= -tolerance for delta in deltas)
    else:
        compliant = sum(delta <= tolerance for delta in deltas)
    return compliant / len(deltas)


def evaluate_controlled_geometry_sample(name: str, behavior: str, timeline: list[dict],
                                        expected_frame_count: int | None,
                                        thresholds: dict | None = None,
                                        coverage_complete: bool | None = None) -> dict:
    """Compare one isolated Premiere control against its declared motion/scale behavior."""
    if behavior not in CONTROL_BEHAVIORS:
        raise ValueError(f"Unknown controlled behavior {behavior!r}; expected one of {sorted(CONTROL_BEHAVIORS)}.")
    limits = {**DEFAULT_CONTROL_THRESHOLDS, **(thresholds or {})}
    usable = [frame for frame in timeline if not frame.get("conflict") and frame.get("width") and frame.get("height")]
    checks: dict[str, dict] = {}

    def check(key: str, passed: bool, measured, expected) -> None:
        checks[key] = {"passed": bool(passed), "measured": measured, "expected": expected}

    check("atLeastTwoUsableFrames", len(usable) >= 2, len(usable), ">= 2")
    count_matches = expected_frame_count is not None and len(timeline) == expected_frame_count
    check("frameCountMatchesTrackedDuration", count_matches, len(timeline), expected_frame_count)
    no_conflicts = all(not frame.get("conflict") for frame in timeline)
    check("noUnresolvedDuplicateConflicts", no_conflicts,
          sum(1 for frame in timeline if frame.get("conflict")), 0)
    if coverage_complete is not None:
        check("expectedTimestampCoverageComplete", coverage_complete, coverage_complete, True)
    dimensions = {(frame.get("sourceWidth"), frame.get("sourceHeight")) for frame in usable}
    check("sourceDimensionsConsistent", len(dimensions) == 1 and None not in next(iter(dimensions), (None, None)),
          sorted(dimensions), "one positive source dimension pair")

    metrics = {"usableFrameCount": len(usable), "totalFrameCount": len(timeline)}
    if usable:
        centers_x = [float(frame["centerX"]) for frame in usable]
        centers_y = [float(frame["centerY"]) for frame in usable]
        widths = [float(frame["width"]) for frame in usable]
        heights = [float(frame["height"]) for frame in usable]
        metrics.update({
            "centerXRangePx": _spread(centers_x), "centerYRangePx": _spread(centers_y),
            "widthRangePx": _spread(widths), "heightRangePx": _spread(heights),
            "firstCenter": {"x": centers_x[0], "y": centers_y[0]},
            "lastCenter": {"x": centers_x[-1], "y": centers_y[-1]},
            "firstSize": {"width": widths[0], "height": heights[0]},
            "lastSize": {"width": widths[-1], "height": heights[-1]},
        })
        stationary_size = limits["stationarySizeTolerancePx"]
        stationary_axis = limits["stationaryAxisTolerancePx"]
        if behavior == "static":
            check("centerXRemainsConstant", _spread(centers_x) <= limits["staticCenterTolerancePx"],
                  _spread(centers_x), f"<= {limits['staticCenterTolerancePx']} px")
            check("centerYRemainsConstant", _spread(centers_y) <= limits["staticCenterTolerancePx"],
                  _spread(centers_y), f"<= {limits['staticCenterTolerancePx']} px")
            check("widthRemainsConstant", _spread(widths) <= limits["staticSizeTolerancePx"],
                  _spread(widths), f"<= {limits['staticSizeTolerancePx']} px")
            check("heightRemainsConstant", _spread(heights) <= limits["staticSizeTolerancePx"],
                  _spread(heights), f"<= {limits['staticSizeTolerancePx']} px")
        elif behavior == "horizontal":
            movement = abs(centers_x[-1] - centers_x[0])
            check("horizontalMotionIsSubstantial", movement >= limits["minimumMotionPx"],
                  movement, f">= {limits['minimumMotionPx']} px net displacement")
            check("centerYRemainsConstant", _spread(centers_y) <= stationary_axis,
                  _spread(centers_y), f"<= {stationary_axis} px")
            check("widthRemainsConstant", _spread(widths) <= stationary_size,
                  _spread(widths), f"<= {stationary_size} px")
            check("heightRemainsConstant", _spread(heights) <= stationary_size,
                  _spread(heights), f"<= {stationary_size} px")
        elif behavior == "vertical":
            movement = abs(centers_y[-1] - centers_y[0])
            check("verticalMotionIsSubstantial", movement >= limits["minimumMotionPx"],
                  movement, f">= {limits['minimumMotionPx']} px net displacement")
            check("centerXRemainsConstant", _spread(centers_x) <= stationary_axis,
                  _spread(centers_x), f"<= {stationary_axis} px")
            check("widthRemainsConstant", _spread(widths) <= stationary_size,
                  _spread(widths), f"<= {stationary_size} px")
            check("heightRemainsConstant", _spread(heights) <= stationary_size,
                  _spread(heights), f"<= {stationary_size} px")
        else:
            direction = "up" if behavior == "scale-up" else "down"
            ratio_limit = limits["minimumScaleChangeRatio"]
            width_ratio, height_ratio = widths[-1] / widths[0], heights[-1] / heights[0]
            scale_ratio = geometry_scale_ratio(usable[0], usable[-1])
            width_trend = _trend_fraction(widths, direction, limits["monotonicStepTolerancePx"])
            height_trend = _trend_fraction(heights, direction, limits["monotonicStepTolerancePx"])
            trend_limit = limits["scaleMonotonicFraction"]
            width_pass = (width_ratio >= ratio_limit if direction == "up" else width_ratio <= 1 / ratio_limit) and width_trend >= trend_limit
            height_pass = (height_ratio >= ratio_limit if direction == "up" else height_ratio <= 1 / ratio_limit) and height_trend >= trend_limit
            if direction == "up":
                scale_pass = scale_ratio > 1
            else:
                scale_pass = scale_ratio < 1
            check("scaleDirectionIsCorrect", scale_pass, scale_ratio,
                  "> 1 graphic-follow ratio" if direction == "up" else "< 1 graphic-follow ratio")
            check("widthAndHeightChangeConsistently", width_pass and height_pass,
                  {"widthRatio": width_ratio, "heightRatio": height_ratio,
                   "widthMonotonicFraction": width_trend, "heightMonotonicFraction": height_trend},
                  f"both dimensions change {direction} by configured ratio with >= {trend_limit:.0%} consistent steps")
            metrics.update({"widthRatio": width_ratio, "heightRatio": height_ratio,
                            "graphicFollowScaleRatio": scale_ratio,
                            "widthMonotonicFraction": width_trend,
                            "heightMonotonicFraction": height_trend,
                            "centerDriftDuringScalePx": {
                                "netX": centers_x[-1] - centers_x[0],
                                "netY": centers_y[-1] - centers_y[0],
                                "rangeX": _spread(centers_x),
                                "rangeY": _spread(centers_y),
                            }})

    failures = [key for key, value in checks.items() if not value["passed"]]
    insufficient = len(usable) < 2 or expected_frame_count is None
    status = "insufficient" if insufficient else "passed" if not failures else "failed"
    return {"name": name, "behavior": behavior, "status": status,
            "passed": status == "passed", "thresholds": limits,
            "checks": checks, "failedChecks": failures, "metrics": metrics,
            "rotation": "unsupported; axis-aligned rectangles do not establish orientation"}


def validate_control_manifest(path: str) -> dict:
    """Build reproducible machine-readable reports for isolated Premiere controls."""
    manifest_path = Path(path).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    samples = manifest.get("samples")
    if not isinstance(samples, list):
        raise ValueError("Control manifest must contain a samples array.")
    thresholds = {**DEFAULT_CONTROL_THRESHOLDS, **manifest.get("thresholds", {})}
    tolerance = float(manifest.get("conflictTolerancePx", 5))
    reports = []
    seen_behaviors = set()
    for sample in samples:
        behavior = sample.get("behavior")
        if behavior not in CONTROL_BEHAVIORS:
            raise ValueError(f"Sample {sample.get('name')!r} must declare a behavior from {sorted(CONTROL_BEHAVIORS)}.")
        seen_behaviors.add(behavior)
        files = sample.get("files")
        project = sample.get("project")
        project_path = str((manifest_path.parent / project).resolve()) if project and not Path(project).is_absolute() else str(Path(project).resolve()) if project else None
        track_item_id = str(sample["trackItemId"]) if sample.get("trackItemId") is not None else None
        sample_tolerance = float(sample.get("conflictTolerancePx", tolerance))
        project_timing = project_track_timing(project_path, track_item_id) if project_path and track_item_id else None
        if bool(project_path) != bool(track_item_id):
            raise ValueError(f"Sample {sample.get('name')!r} must supply both project and trackItemId.")
        resolved_references = []
        if project_path and track_item_id:
            project_report = inspect_project(project_path, track_item_id)
            target_items = [item for item in project_report["trackItemsWithAemask2"]
                            if item["trackItemId"] == track_item_id]
            if len(target_items) != 1:
                raise ValueError(f"Sample {sample.get('name')!r} TrackItem {track_item_id} did not resolve uniquely in the project.")
            tracker_uuid_tokens = sorted({uuid_text.lower()
                                          for root in target_items[0]["aemask2Roots"]
                                          for tracker in root["trackerParameters"]
                                          for uuid_text in tracker.get("startValueUuidStrings", [])})
            resolved_references = sorted({uuid_text.lower()
                                          for root in target_items[0]["aemask2Roots"]
                                          for tracker in root["trackerParameters"]
                                          for uuid_text in tracker.get("sidecarMatches", [])})
            if not resolved_references:
                raise ValueError(f"Sample {sample.get('name')!r} TrackItem {track_item_id} has no Tracker UUID sidecar references.")
            sidecar_by_uuid = {Path(project_report["maskFolder"], filename).stem.lower():
                               str(Path(project_report["maskFolder"], filename).resolve())
                               for filename in project_report["sidecarNames"]}
            unresolved = [uuid_text for uuid_text in resolved_references if uuid_text not in sidecar_by_uuid]
            if unresolved:
                raise ValueError(f"Sample {sample.get('name')!r} has unresolved Tracker UUID sidecars: {unresolved}.")
            referenced_files = [sidecar_by_uuid[uuid_text] for uuid_text in resolved_references]
            if files is not None:
                if not isinstance(files, list) or not files:
                    raise ValueError(f"Sample {sample.get('name')!r} files must be a non-empty array when supplied.")
                resolved_files = [str((manifest_path.parent / item).resolve()) if not Path(item).is_absolute() else str(Path(item).resolve())
                                  for item in files]
                supplied_uuids = {Path(item).stem.lower() for item in resolved_files}
                if supplied_uuids != set(resolved_references):
                    raise ValueError(f"Sample {sample.get('name')!r} files do not exactly match its Tracker UUID references; expected {resolved_references}.")
            else:
                resolved_files = referenced_files
        else:
            if not isinstance(files, list) or not files:
                raise ValueError(f"Sample {sample.get('name')!r} must supply project/trackItemId or list one or more .prmf files.")
            resolved_files = [str((manifest_path.parent / item).resolve()) if not Path(item).is_absolute() else str(Path(item).resolve())
                              for item in files]
        if project_timing:
            expected_times = project_timing["expectedTimes"]
        elif sample.get("expectedTimes") is not None:
            expected_times = [int(value) for value in sample["expectedTimes"]]
        elif sample.get("expectedFrameCount") is not None and sample.get("startTimeTicks") is not None and sample.get("frameDurationTicks") is not None:
            expected_times = [int(sample["startTimeTicks"]) + index * int(sample["frameDurationTicks"])
                              for index in range(int(sample["expectedFrameCount"]))]
        else:
            expected_times = None
        sidecars = [decode_prmf_v3_candidate_geometry(item) for item in resolved_files]
        temporal_sidecars, untimed_singletons = _temporal_frame_sidecars(sidecars)
        assign_missing_project_frame_times(temporal_sidecars, expected_times)
        records = [frame for sidecar in temporal_sidecars for frame in sidecar["candidateFrames"]]
        merged = canonical_rectangle_timeline(records, sample_tolerance, expected_times)
        expected_count = (project_timing["expectedSampleCount"] if project_timing else
                          int(sample["expectedFrameCount"]) if sample.get("expectedFrameCount") is not None else
                          len(expected_times) if expected_times is not None else None)
        coverage = merged["timelineCoverage"]["complete"] if expected_times is not None else False
        report = evaluate_controlled_geometry_sample(
            str(sample.get("name", behavior)), behavior, merged["candidateTimeline"],
            expected_count, thresholds, coverage)
        dimensions = sorted({(frame["sourceWidth"], frame["sourceHeight"])
                             for sidecar in sidecars for frame in sidecar["candidateFrames"]})
        report["inputs"] = {
            "project": str(Path(project_path).resolve()) if project_path else None,
            "trackItemId": track_item_id,
            "trackerUuidReferences": resolved_references,
            "trackerUuidTokensWithoutSidecarMatch": [value for value in tracker_uuid_tokens if value not in resolved_references],
            "projectTiming": ({key: value for key, value in project_timing.items() if key != "expectedTimes"}
                              if project_timing else None),
            "sidecars": [{"uuid": Path(sidecar["path"]).stem,
                          "path": sidecar["path"], "prmfVersion": 3,
                          "recordCount": sidecar["frameCount"], "fileBytes": sidecar["fileBytes"],
                          "storedTimestampCount": sidecar["storedTimestampCount"],
                          "role": "temporal-frame-candidate" if sidecar in temporal_sidecars else "untimed-single-record-reference-candidate",
                          "header": sidecar["layout"]} for sidecar in sidecars],
            "recordCount": sum(sidecar["frameCount"] for sidecar in sidecars),
            "temporalRecordCount": len(records),
            "untimedSingleRecordReferenceCount": sum(sidecar["frameCount"] for sidecar in untimed_singletons),
            "candidateFrameCount": merged["uniqueTimeCount"],
            "duplicateTimestampCount": merged["duplicateTimeCount"],
            "maximumDuplicateDisagreementPx": merged["maximumDuplicateCoordinateDisagreementPx"],
            "sourceDimensions": [{"width": width, "height": height} for width, height in dimensions],
            "timelineCoverage": merged["timelineCoverage"],
            "duplicatePolicy": "exact rectangles collapsed; near rectangles coordinate-wise median; larger disagreements unresolved",
        }
        report["untimedSingleRecordReferences"] = [
            {"uuid": Path(sidecar["path"]).stem,
             "file": Path(sidecar["path"]).name,
             "recordCount": sidecar["frameCount"],
             "candidateFrames": sidecar["candidateFrames"],
             "reasonExcludedFromTimeline": "single candidate record has no stored timestamp; retained separately rather than assigning an arbitrary frame time"}
            for sidecar in untimed_singletons
        ]
        report["candidateTimeline"] = merged["candidateTimeline"]
        reports.append(report)
    required = sorted(CONTROL_BEHAVIORS)
    missing = sorted(CONTROL_BEHAVIORS - seen_behaviors)
    all_passed = not missing and all(report["passed"] for report in reports)
    return {
        "manifest": str(manifest_path),
        "reportVersion": 1,
        "requiredBehaviors": required,
        "missingBehaviors": missing,
        "samples": reports,
        "controlledValidationStatus": "passed" if all_passed else "incomplete-or-failed",
        "experimentalPromotionEligible": all_passed,
        "experimentalObjectMaskIntegrationEnabled": all_passed,
        "productionObjectMaskIntegrationEnabled": False,
        "autoScaleEnabled": all_passed,
        "liveTransformReadbackVerified": False,
        "rotationEnabled": False,
        "scalePolicy": "graphic-follow; sqrt((currentWidth/referenceWidth)*(currentHeight/referenceHeight)); no inversion",
        "positionPolicy": "center delta from reference; preserve pre-existing Position; never write Anchor Point",
    }


def _codec_candidate_offsets(data: bytes, payload_start: int, payload_end: int, stride: int,
                            frame_offsets: list[int] | None = None, limit: int = 8192) -> list[int]:
    if stride < 1:
        raise ValueError("Codec scan stride must be positive.")
    if not data:
        return []
    payload_start = max(0, min(payload_start, len(data)))
    payload_end = max(payload_start, min(payload_end, len(data)))
    effective_stride = max(stride, math.ceil(max(1, payload_end - payload_start) / limit))
    candidates = set(range(payload_start, payload_end, effective_stride))
    candidates.update(offset for offset in (frame_offsets or []) if payload_start <= offset < payload_end)
    if len(candidates) > limit:
        # Keep frame-record starts and sample the payload grid evenly.
        frame_candidates = set(offset for offset in (frame_offsets or []) if payload_start <= offset < payload_end)
        grid = sorted(candidates - frame_candidates)
        room = max(0, limit - len(frame_candidates))
        keep_grid = set(grid[::max(1, math.ceil(len(grid) / max(1, room)))]) if room else set()
        candidates = frame_candidates | keep_grid
    return sorted(candidates)[:limit]


def _read_varint(data: bytes, offset: int, max_bytes: int = 5) -> tuple[int, int] | None:
    value = 0
    for index in range(max_bytes):
        at = offset + index
        if at >= len(data):
            return None
        byte = data[at]
        value |= (byte & 0x7F) << (7 * index)
        if byte < 0x80:
            return value, index + 1
    return None


def _flatbuffer_table_candidate(data: bytes, offset: int) -> dict | None:
    if offset < 0 or offset + 8 > len(data):
        return None
    root_distance = struct.unpack_from("<I", data, offset)[0]
    table = offset + root_distance
    if root_distance < 4 or table + 4 > len(data):
        return None
    vtable_distance = struct.unpack_from("<i", data, table)[0]
    if vtable_distance <= 0:
        return None
    vtable = table - vtable_distance
    if vtable < offset or vtable + 4 > len(data):
        return None
    vtable_bytes, object_bytes = struct.unpack_from("<HH", data, vtable)
    if vtable_bytes < 4 or vtable_bytes % 2 or object_bytes < 4 or vtable + vtable_bytes > len(data) or table + object_bytes > len(data):
        return None
    fields = struct.unpack_from("<%dH" % ((vtable_bytes - 4) // 2), data, vtable + 4) if vtable_bytes > 4 else ()
    if any(field and (field < 4 or field >= object_bytes) for field in fields):
        return None
    return {"offset": offset, "rootTableOffset": root_distance, "vtableOffset": vtable - offset,
            "vtableBytes": vtable_bytes, "objectBytes": object_bytes, "fieldCount": len(fields)}


def _protobuf_varint_run(data: bytes, offset: int, max_bytes: int = 128, minimum_fields: int = 6) -> dict | None:
    end = min(len(data), offset + max_bytes)
    cursor, field_count, field_numbers = offset, 0, []
    while cursor < end:
        tag_read = _read_varint(data[:end], cursor)
        if not tag_read:
            break
        tag, used = tag_read
        field_number, wire_type = tag >> 3, tag & 7
        if field_number == 0 or wire_type not in (0, 1, 2, 5):
            break
        cursor += used
        if wire_type == 0:
            value_read = _read_varint(data[:end], cursor)
            if not value_read:
                break
            _, used = value_read
            cursor += used
        elif wire_type == 1:
            cursor += 8
        elif wire_type == 2:
            length_read = _read_varint(data[:end], cursor)
            if not length_read:
                break
            length, used = length_read
            cursor += used + length
        else:
            cursor += 4
        if cursor > end:
            break
        field_count += 1
        field_numbers.append(field_number)
        if field_count >= minimum_fields:
            return {"offset": offset, "fieldCount": field_count, "fieldNumbers": field_numbers,
                    "parsedBytes": cursor - offset, "heuristicOnly": True}
    return None


def _scan_frame_payload_codecs(data: bytes, frames: list[dict], max_output_bytes: int) -> dict:
    chunks = [(frame["payloadOffset"], data[frame["payloadOffset"]:
              frame["payloadOffset"] + frame["payloadBytes"]]) for frame in frames]
    entropy = [shannon_entropy(chunk) for _, chunk in chunks]
    results: dict[str, dict] = {
        "chunkCount": len(chunks),
        "chunkEntropy": {"min": round(min(entropy), 5) if entropy else 0,
                         "max": round(max(entropy), 5) if entropy else 0,
                         "mean": round(sum(entropy) / len(entropy), 5) if entropy else 0},
    }

    zlib_hits = []
    for offset, chunk in chunks:
        for codec, window_bits in (("zlib", zlib.MAX_WBITS), ("gzip", 16 + zlib.MAX_WBITS),
                                   ("rawDeflate", -zlib.MAX_WBITS)):
            try:
                decoder = zlib.decompressobj(window_bits)
                decoded = decoder.decompress(chunk, max_output_bytes)
                if decoder.eof and len(decoded) >= 16 and not decoder.unused_data:
                    zlib_hits.append({"codec": codec, "offset": offset,
                                      "compressedBytes": len(chunk), "decodedBytes": len(decoded)})
            except (zlib.error, ValueError, MemoryError):
                continue
    results["zlibGzipRawDeflate"] = {"available": True, "validExactChunkCount": len(zlib_hits),
                                    "streams": zlib_hits[:32]}

    try:
        import brotli
        hits = []
        for offset, chunk in chunks:
            try:
                decoded = brotli.decompress(chunk)
                if len(decoded) >= 16:
                    hits.append({"offset": offset, "compressedBytes": len(chunk), "decodedBytes": len(decoded)})
            except brotli.error:
                continue
        results["brotli"] = {"available": True, "validExactChunkCount": len(hits), "streams": hits[:32]}
    except ImportError:
        results["brotli"] = {"available": False}

    try:
        import zstandard
        hits = []
        for offset, chunk in chunks:
            try:
                decoded = zstandard.ZstdDecompressor().decompress(chunk, max_output_size=max_output_bytes)
                if len(decoded) >= 16:
                    hits.append({"format": "standard", "offset": offset, "decodedBytes": len(decoded)})
            except (zstandard.ZstdError, ValueError, MemoryError):
                pass
            format_id = getattr(zstandard, "FORMAT_ZSTD1_MAGICLESS", None)
            if format_id is not None:
                try:
                    decoded = zstandard.ZstdDecompressor(format=format_id).decompress(
                        chunk, max_output_size=max_output_bytes)
                    if len(decoded) >= 16:
                        hits.append({"format": "magicless", "offset": offset, "decodedBytes": len(decoded)})
                except (zstandard.ZstdError, ValueError, MemoryError):
                    pass
        results["zstandard"] = {"available": True, "validExactChunkCount": len(hits), "streams": hits[:32]}
    except ImportError:
        results["zstandard"] = {"available": False}

    try:
        import lz4.block
        import lz4.frame
        block_hits = []
        guessed_sizes = (64, 128, 256, 512, 1024, 2048, 4096, 8192,
                         16384, 32768, 65536, 131072, 262144, 524288, 1048576)
        for offset, chunk in chunks:
            for expected_size in guessed_sizes:
                try:
                    decoded = lz4.block.decompress(chunk, uncompressed_size=expected_size)
                    if len(decoded) >= 16:
                        block_hits.append({"format": "rawBlock", "offset": offset,
                                           "expectedBytes": expected_size, "decodedBytes": len(decoded)})
                        break
                except Exception:
                    continue
        hits = []
        for offset, chunk in chunks:
            try:
                decoded = lz4.frame.decompress(chunk)
                if len(decoded) >= 16:
                    hits.append({"format": "frame", "offset": offset, "decodedBytes": len(decoded)})
            except (RuntimeError, ValueError, MemoryError):
                continue
        results["lz4"] = {"available": True, "rawBlockSizeGuesses": list(guessed_sizes),
                           "validExactRawBlockCount": len(block_hits), "rawBlockStreams": block_hits[:32],
                           "validExactFrameCount": len(hits), "frameStreams": hits[:32]}
    except ImportError:
        results["lz4"] = {"available": False}

    try:
        import snappy
        hits = []
        plausible_prefixes = 0
        for offset, chunk in chunks:
            prefix = _read_varint(chunk, 0, 5)
            if prefix and 16 <= prefix[0] <= max_output_bytes:
                plausible_prefixes += 1
            try:
                decoded = snappy.decompress(chunk)
                if len(decoded) >= 16:
                    hits.append({"offset": offset, "compressedBytes": len(chunk), "decodedBytes": len(decoded)})
            except (ValueError, RuntimeError, snappy.UncompressError):
                continue
        results["snappyRaw"] = {"available": True, "plausibleLengthPrefixes": plausible_prefixes,
                                "validExactChunkCount": len(hits), "streams": hits[:32]}
    except ImportError:
        results["snappyRaw"] = {"available": False}

    try:
        import lzfse
        hits = []
        for offset, chunk in chunks:
            try:
                decoded = lzfse.decompress(chunk)
                if len(decoded) >= 16:
                    hits.append({"offset": offset, "compressedBytes": len(chunk), "decodedBytes": len(decoded)})
            except Exception:
                continue
        results["lzfse"] = {"available": True, "validExactChunkCount": len(hits), "streams": hits[:32]}
    except ImportError:
        results["lzfse"] = {"available": False}
    return results


def _raw_deflate_sweep(data: bytes, max_output_bytes: int = 4096) -> dict:
    hits = []
    view = memoryview(data)
    for offset in range(max(0, len(data) - 1)):
        try:
            decoder = zlib.decompressobj(-zlib.MAX_WBITS)
            decoded = decoder.decompress(view[offset:], max_output_bytes)
            if decoder.eof and len(decoded) >= 16:
                hits.append({"offset": offset, "compressedBytes": len(data) - offset - len(decoder.unused_data),
                             "decodedBytes": len(decoded)})
        except (zlib.error, ValueError, MemoryError):
            continue
    lengths = sorted(hit["decodedBytes"] for hit in hits)
    return {"bytesScanned": len(data), "validStreamCount": len(hits),
            "medianDecodedBytes": lengths[len(lengths) // 2] if lengths else None,
            "hits": hits[:32]}


def codec_scan(path: str, stride: int = 64, max_output_bytes: int = 8 * 1024 * 1024) -> dict:
    """Try framed and plausible unframed codec starts without treating a hit as a decoder."""
    data = read_file(path)
    layout = _prmf_layout(data)
    if not layout["valid"]:
        raise ValueError("The file does not match the observed PRMF v3 payload/trailer bounds.")
    try:
        geometry = decode_prmf_v3_candidate_geometry(path)
        frame_offsets = [frame["payloadOffset"] for frame in geometry["candidateFrames"]]
    except ValueError:
        geometry = None
        frame_offsets = []
    payload_start, payload_end = layout["payloadStart"], layout["payloadEnd"]
    exact_frames = geometry["candidateFrames"] if geometry else []
    candidates = _codec_candidate_offsets(data, payload_start, payload_end, stride, frame_offsets)
    signature_report = signatures(data)
    results: dict[str, dict] = {}

    standard = compression_streams(data)
    results["zlibGzip"] = {"validStreamCount": standard["validStreamCount"], "streams": standard["streams"],
                           "zlibCandidateCount": signature_report["zlibCandidateCount"]}

    raw_deflate_hits = []
    view = memoryview(data)
    for offset in candidates:
        try:
            decoder = zlib.decompressobj(-zlib.MAX_WBITS)
            decoded = decoder.decompress(view[offset:], max_output_bytes)
            if decoder.eof and len(decoded) >= 16:
                raw_deflate_hits.append({"offset": offset, "decodedBytes": len(decoded),
                                         "compressedBytes": len(data) - offset - len(decoder.unused_data),
                                         "decodedPrefixHex": decoded[:32].hex(" ")})
        except (zlib.error, ValueError, MemoryError):
            continue
    results["rawDeflate"] = {"attemptedOffsets": len(candidates), "validStreamCount": len(raw_deflate_hits),
                             "streams": raw_deflate_hits[:32],
                             "interpretation": "Arbitrary-offset successes need a random-data false-positive baseline; exact frame-chunk results are below."}
    results["exactFrameChunks"] = _scan_frame_payload_codecs(data, exact_frames, max_output_bytes) if exact_frames else {
        "chunkCount": 0, "reason": "No strict candidate frame records were parsed."}
    payload = data[payload_start:payload_end]
    random_payload = random.Random(260925).randbytes(len(payload))
    observed_deflate = _raw_deflate_sweep(payload)
    random_deflate = _raw_deflate_sweep(random_payload)
    results["rawDeflateRandomBaseline"] = {
        "observedPayload": {key: value for key, value in observed_deflate.items() if key != "hits"},
        "deterministicRandomSameLength": {key: value for key, value in random_deflate.items() if key != "hits"},
        "interpretation": "Similar hit counts on this high-entropy payload and deterministic random bytes do not establish embedded DEFLATE.",
    }

    try:
        import brotli
        brotli_hits = []
        for offset in candidates:
            decoder = brotli.Decompressor()
            decoded_bytes = 0
            try:
                for start in range(offset, len(data), 1024):
                    decoded_bytes += len(decoder.process(data[start:start + 1024]))
                    if decoded_bytes > max_output_bytes:
                        break
                    if decoder.is_finished():
                        if decoded_bytes >= 16:
                            brotli_hits.append({"offset": offset, "decodedBytes": decoded_bytes})
                        break
            except brotli.error:
                continue
        results["brotli"] = {"available": True, "attemptedOffsets": len(candidates), "validStreamCount": len(brotli_hits), "streams": brotli_hits[:32]}
    except ImportError:
        results["brotli"] = {"available": False, "reason": "Optional brotli package is not installed."}

    try:
        import zstandard
        zstd_hits = []
        format_id = getattr(zstandard, "FORMAT_ZSTD1_MAGICLESS", None)
        if format_id is not None:
            decoder_factory = lambda: zstandard.ZstdDecompressor(format=format_id)
            for offset in candidates:
                try:
                    decoded = decoder_factory().decompress(data[offset:], max_output_size=max_output_bytes)
                    if len(decoded) >= 16:
                        zstd_hits.append({"offset": offset, "decodedBytes": len(decoded), "format": "magicless"})
                except (zstandard.ZstdError, ValueError, MemoryError):
                    continue
        results["zstandard"] = {"available": True, "standardMagicMatches": [item["offset"] for item in signature_report["known"] if item["signature"] == "Zstandard frame"],
                                "magiclessAttemptedOffsets": len(candidates) if format_id is not None else 0,
                                "magiclessValidStreamCount": len(zstd_hits), "streams": zstd_hits[:32],
                                "magiclessSupported": format_id is not None}
    except ImportError:
        results["zstandard"] = {"available": False, "reason": "Optional zstandard package is not installed."}

    framed_magics = {
        "lz4Frame": b"\x04\x22\x4d\x18",
        "snappyFrame": b"\xff\x06\x00\x00sNaPpY",
        "lzfseBvx1": b"bvx1", "lzfseBvx2": b"bvx2", "lzfseBvxn": b"bvxn", "lzfseBvxDash": b"bvx-",
    }
    magic_offsets = {name: [] for name in framed_magics}
    for name, magic in framed_magics.items():
        start = 0
        while True:
            offset = data.find(magic, start)
            if offset < 0:
                break
            magic_offsets[name].append(offset)
            start = offset + 1

    try:
        import lz4.block
        lz4_offsets = set(range(payload_start, payload_end, max(256, stride * 4)))
        lz4_offsets.update(frame_offsets)
        lz4_offsets = sorted(lz4_offsets)[:1024]
        sizes = (64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576)
        lz4_hits = []
        for offset in lz4_offsets:
            for expected_size in sizes:
                try:
                    decoded = lz4.block.decompress(data[offset:], uncompressed_size=expected_size)
                    if len(decoded) >= 16:
                        lz4_hits.append({"offset": offset, "expectedBytes": expected_size, "decodedBytes": len(decoded)})
                        break
                except (lz4.block.LZ4BlockError, ValueError, MemoryError):
                    continue
        results["lz4"] = {"available": True, "frameMagicOffsets": magic_offsets["lz4Frame"],
                          "rawBlockAttemptedOffsets": len(lz4_offsets), "rawBlockExpectedSizes": list(sizes),
                          "rawBlockHitCount": len(lz4_hits), "rawBlockHits": lz4_hits[:32],
                          "rawBlockScanIsHeuristic": True}
    except ImportError:
        results["lz4"] = {"available": False, "frameMagicOffsets": magic_offsets["lz4Frame"], "reason": "Optional lz4 package is not installed."}

    try:
        import snappy
        snappy_offsets = candidates
        snappy_hits = []
        plausible_prefixes = 0
        for offset in snappy_offsets:
            prefix = _read_varint(data, offset, 5)
            if not prefix:
                continue
            expected, prefix_bytes = prefix
            if expected < 16 or expected > max_output_bytes:
                continue
            plausible_prefixes += 1
            try:
                decoded = snappy.decompress(data[offset:])
                if len(decoded) == expected:
                    snappy_hits.append({"offset": offset, "decodedBytes": len(decoded), "prefixBytes": prefix_bytes})
            except (ValueError, RuntimeError, snappy.UncompressError):
                continue
        results["snappy"] = {"available": True, "frameMagicOffsets": magic_offsets["snappyFrame"],
                            "rawAttemptedOffsets": len(snappy_offsets), "plausibleLengthPrefixes": plausible_prefixes,
                            "validRawBlocks": snappy_hits[:32], "validRawBlockCount": len(snappy_hits)}
    except ImportError:
        results["snappy"] = {"available": False, "frameMagicOffsets": magic_offsets["snappyFrame"], "reason": "Optional python-snappy package is not installed."}

    try:
        import lzfse
        lzfse_markers = sorted({offset for offsets in magic_offsets.values() for offset in offsets if 0 <= offset < len(data)})
        lzfse_hits = []
        for offset in lzfse_markers:
            try:
                decoded = lzfse.decompress(data[offset:])
                if len(decoded) >= 16:
                    lzfse_hits.append({"offset": offset, "decodedBytes": len(decoded)})
            except (ValueError, RuntimeError):
                continue
        results["lzfse"] = {"available": True, "magicOffsets": magic_offsets, "attemptedOffsets": len(lzfse_markers),
                            "validStreams": lzfse_hits}
    except ImportError:
        results["lzfse"] = {"available": False, "magicOffsets": magic_offsets, "reason": "Optional lzfse package is not installed."}

    try:
        import msgpack
        msgpack_offsets = sorted(set([payload_start, 0] + candidates[::max(1, math.ceil(len(candidates) / 512))]))
        msgpack_hits = []
        for offset in msgpack_offsets:
            try:
                value = msgpack.unpackb(data[offset:], raw=False, strict_map_key=False)
                if isinstance(value, (dict, list, tuple)):
                    msgpack_hits.append({"offset": offset, "topLevelType": type(value).__name__,
                                         "itemCount": len(value), "singleObjectConsumesSuffix": True})
            except (ValueError, TypeError, msgpack.exceptions.UnpackException, msgpack.exceptions.ExtraData, msgpack.exceptions.FormatError):
                continue
        results["messagePack"] = {"available": True, "attemptedOffsets": len(msgpack_offsets),
                                  "topLevelContainerCount": len(msgpack_hits), "candidates": msgpack_hits[:32]}
    except ImportError:
        results["messagePack"] = {"available": False, "reason": "Optional msgpack package is not installed."}

    flatbuffer_offsets = range(layout["trailerOffset"], max(layout["trailerOffset"], len(data) - 8), 4)
    flatbuffer_hits = []
    for offset in flatbuffer_offsets:
        candidate = _flatbuffer_table_candidate(data, offset)
        if candidate:
            flatbuffer_hits.append(candidate)
    protobuf_offsets = candidates[::max(1, math.ceil(len(candidates) / 1024))]
    protobuf_hits = []
    for offset in protobuf_offsets:
        candidate = _protobuf_varint_run(data, offset)
        if candidate:
            protobuf_hits.append(candidate)
    results["structureHeuristics"] = {
        "flatBuffers": {"fourByteAlignedOffsetsChecked": len(flatbuffer_offsets), "structuralCandidates": len(flatbuffer_hits), "candidates": flatbuffer_hits[:32]},
        "protobufVarints": {"candidateOffsetsChecked": len(protobuf_offsets), "runsOfSixOrMoreFields": len(protobuf_hits), "candidates": protobuf_hits[:32],
                             "warning": "Varint shape alone does not establish protobuf semantics."},
        "messagePack": results.pop("messagePack", {"available": False}),
        "lengthPrefixSearch": {"testedWidthEndianPairs": ["uint16le", "uint16be", "uint32le", "uint32be", "varint32"],
                               "note": "Frame count, timestamp, dimensions, per-frame geometry, payload offsets, and payload lengths have candidate trailer fields; their schema remains subject to controlled validation."},
    }
    return {"path": str(Path(path).resolve()), "fileBytes": len(data), "sha256": sha256(data),
        "prmfLayout": {"payloadStart": payload_start, "payloadEnd": payload_end,
                       "payloadBytes": layout["payloadBytes"], "trailerOffset": layout["trailerOffset"],
                       "trailerBytes": layout["trailerBytes"]},
        "candidateStartOffsets": {"stride": stride, "count": len(candidates), "examples": candidates[:64]},
        "candidateFrameCount": geometry["frameCount"] if geometry else None,
            "signatures": signature_report["known"], "codecResults": results,
            "conclusion": "Trailer geometry candidates are separate from mask payload decoding; standard codec hits at arbitrary offsets require a random-data false-positive baseline."}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("inspect", help="summarize signatures, entropy, header words and strings")
    p.add_argument("file"); p.add_argument("--block-size", type=int, default=4096)
    p = sub.add_parser("diff", help="report byte-exact changed ranges and a per-block heatmap")
    p.add_argument("left"); p.add_argument("right"); p.add_argument("--context", type=int, default=8)
    p.add_argument("--block-size", type=int, default=256, help="bytes represented by each heatmap glyph")
    p = sub.add_parser("hex", help="hex dump a range")
    p.add_argument("file"); p.add_argument("--offset", type=lambda x: int(x, 0), default=0); p.add_argument("--length", type=lambda x: int(x, 0), default=256)
    p = sub.add_parser("floats", help="scan finite float values in a numeric range")
    p.add_argument("file"); p.add_argument("--width", type=int, choices=(32, 64), default=32); p.add_argument("--endian", choices=("le", "be"), default="le")
    p.add_argument("--min", dest="minimum", type=float, default=-10); p.add_argument("--max", dest="maximum", type=float, default=10); p.add_argument("--stride", type=int, default=1)
    p = sub.add_parser("find-int", help="find known dimensions or values in a selected integer encoding")
    p.add_argument("file"); p.add_argument("values", nargs="+", type=int); p.add_argument("--width", type=int, choices=(16, 32, 64), default=32); p.add_argument("--endian", choices=("le", "be"), default="le")
    p = sub.add_parser("extract", help="write a candidate byte block to a new file")
    p.add_argument("file"); p.add_argument("output"); p.add_argument("--offset", type=lambda x: int(x, 0), required=True); p.add_argument("--length", type=lambda x: int(x, 0), required=True)
    p = sub.add_parser("correlate", help="rank byte offsets correlated with known object geometry")
    p.add_argument("manifest", help="JSON: {samples:[{file,centerX,centerY,width,height}, ...]}"); p.add_argument("--top", type=int, default=30)
    p = sub.add_parser("project", help="inspect saved-project AEMask2 components, tracker payload metadata, and sidecar UUID references")
    p.add_argument("file")
    p.add_argument("--track-item-id", help="inspect one decimal VideoClipTrackItem ID from the saved project")
    p.add_argument("--details", action="store_true", help="include binary start-value previews for component parameters")
    p = sub.add_parser("prmf-header", help="report observed PRMF v3 payload and trailer boundaries")
    p.add_argument("file")
    p = sub.add_parser("codec-scan", help="try framed and candidate-offset codecs on a PRMF payload")
    p.add_argument("file")
    p.add_argument("--stride", type=int, default=64, help="sampling step between unframed codec start candidates")
    p.add_argument("--max-output-mib", type=int, default=8, help="maximum output limit per decompression attempt")
    p = sub.add_parser("candidate-geometry", help="extract observed PRMF v3 rectangle/time candidates without enabling plugin output")
    p.add_argument("files", nargs="+", help="one or more PRMF v3 sidecars to inspect independently")
    p.add_argument("--project", help="optional saved Premiere project for source clip timing checks")
    p.add_argument("--track-item-id", help="TrackItem ID paired with --project")
    p.add_argument("--conflict-tolerance-px", type=float, default=5,
                   help="maximum coordinate disagreement resolved by coordinate-wise median (default: 5)")
    p = sub.add_parser("validate-controls", help="compare isolated static/motion/scale controls against candidate PRMF rectangles")
    p.add_argument("manifest", help="JSON manifest containing project/TrackItem and sidecar inputs for required controls")
    return parser.parse_args()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    args = parse_args()
    try:
        if args.command == "inspect":
            result = inspect(args.file, args.block_size)
        elif args.command == "diff":
            left, right = read_file(args.left), read_file(args.right)
            ranges = changed_ranges(left, right, args.context)
            result = {"left": args.left, "right": args.right, "leftBytes": len(left), "rightBytes": len(right),
                      "changedRanges": ranges, "changedRangeCount": len(ranges),
                      "visualChangeMap": changed_block_map(left, right, args.block_size)}
        elif args.command == "hex":
            data = read_file(args.file)
            start, end = args.offset, min(len(data), args.offset + args.length)
            if start < 0 or end < start:
                raise ValueError("Offset and length must be non-negative.")
            rows = []
            for offset in range(start, end, 16):
                chunk = data[offset:min(offset + 16, end)]
                ascii_text = "".join(chr(byte) if 32 <= byte <= 126 else "." for byte in chunk)
                rows.append(f"{offset:08x}  {chunk.hex(' '):<47}  {ascii_text}")
            result = {"path": args.file, "size": len(data), "dump": rows}
        elif args.command == "floats":
            if args.stride < 1:
                raise ValueError("Stride must be at least 1 byte.")
            values = scan_floats(read_file(args.file), args.width, args.endian, args.minimum, args.maximum, args.stride)
            result = {"file": args.file, "width": args.width, "endian": args.endian, "range": [args.minimum, args.maximum], "matchCount": len(values), "matches": values[:5000]}
        elif args.command == "find-int":
            data = read_file(args.file)
            result = {"file": args.file, "width": args.width, "endian": args.endian,
                      "matches": {str(value): find_integer(data, value, args.width, args.endian) for value in args.values}}
        elif args.command == "extract":
            data = read_file(args.file)
            if args.offset < 0 or args.length <= 0 or args.offset + args.length > len(data):
                raise ValueError("Candidate block must fit within the source file and have positive length.")
            candidate = data[args.offset:args.offset + args.length]
            out = Path(args.output)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(candidate)
            result = {"source": args.file, "output": str(out.resolve()), "offset": args.offset, "length": len(candidate), "sha256": sha256(candidate)}
        elif args.command == "correlate":
            result = correlate(args.manifest, args.top)
        elif args.command == "project":
            result = inspect_project(args.file, args.track_item_id, args.details)
        elif args.command == "prmf-header":
            result = inspect_prmf_header(args.file)
        elif args.command == "codec-scan":
            if args.max_output_mib < 1:
                raise ValueError("Maximum decoded output must be at least 1 MiB.")
            result = codec_scan(args.file, args.stride, args.max_output_mib * 1024 * 1024)
        elif args.command == "candidate-geometry":
            result = candidate_geometry_report(args.files, args.project, args.track_item_id,
                                               args.conflict_tolerance_px)
        elif args.command == "validate-controls":
            result = validate_control_manifest(args.manifest)
        else:
            raise ValueError(f"Unknown command: {args.command}")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError, struct.error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
