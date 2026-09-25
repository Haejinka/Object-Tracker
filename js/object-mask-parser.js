(function (global) {
  "use strict";

  var TRACKER_MATCH_NAME = "AE.ADBE AEMask2";
  var TRACKER_SAMPLE_BYTES = 104;
  var TICKS_PER_SECOND = 254016000000;
  var CLASSIC_MASK_PRIVATE_DATA_HASH = "801239b7-73d1-ddc5-2fb7-1cc30000007c";

  function versionMajor(version) {
    var match = /^(\d+)/.exec(String(version || ""));
    return match ? Number(match[1]) : null;
  }

  function detectMaskSubtype(binaryHash) {
    var hash = String(binaryHash || "").toLowerCase();
    // Premiere changes this private hash between Object Mask instances and
    // project saves. Only the known classic hash is useful as an exclusion;
    // Object Mask is identified by successfully decoding its linked PRMF data.
    if (hash === CLASSIC_MASK_PRIVATE_DATA_HASH) return "classic-mask";
    return "unconfirmed";
  }

  function detectFormat(input) {
    input = input || {};
    var major = versionMajor(input.premiereVersion);
    var lengths = input.payloadByteLengths || {};
    var lengthKeys = Object.keys(lengths);
    var sampleLength = lengthKeys.length === 1 ? Number(lengthKeys[0]) : null;
    var sidecarSignature = String(input.sidecarSignature || "").toLowerCase();
    var fileSignature = String(input.fileSignature || "unknown");
    var detected = "unknown";
    var parserUsed = "unsupportedFormat";
    var reason = "No registered parser recognizes this input signature and sample layout.";

    if (sidecarSignature.indexOf("prmf/v3") === 0 || sidecarSignature === "prmf v3") {
      detected = "prmf-v3-custom-binary";
      parserUsed = "header-only";
      reason = "PRMF v3 is recognized by its header; frame geometry decoding is performed separately after Premiere version, Tracker UUID, record layout, and source timing checks.";
    } else if (input.matchName === TRACKER_MATCH_NAME) {
      if (sampleLength !== TRACKER_SAMPLE_BYTES || lengthKeys.length !== 1) {
        detected = "aemask2-tracker-unknown-payload-layout";
        reason = "The selected AEMask2 Tracker payload lengths are not a single validated 104-byte sample layout.";
      } else {
        detected = "aemask2-tracker-104-byte-samples";
        if (major === 26) {
          parserUsed = "parser-26.x";
          reason = "Premiere 26.x AEMask2 Tracker records use the observed 104-byte little-endian sample layout.";
        } else if (major === 27) {
          detected = "aemask2-tracker-104-byte-samples-on-27.x";
          reason = "Premiere 27.x is not validated against this private sample layout; parsing is disabled.";
        } else {
          detected = "aemask2-tracker-104-byte-samples-unknown-host";
          reason = "The 104-byte sample shape is recognized, but a validated Premiere major version was not supplied.";
        }
      }
    } else if (input.projectIsGzipXml || /^gzip/i.test(fileSignature)) {
      detected = "gzip-compressed-premiere-project-xml";
      reason = "The project container is readable XML, but its selected tracking parameter is not in a registered sample layout.";
    } else if (input.projectIsXml || /^xml/i.test(fileSignature)) {
      detected = "premiere-project-xml";
      reason = "The project container is readable XML, but its selected tracking parameter is not in a registered sample layout.";
    }

    return {
      premiereVersion: input.premiereVersion || null,
      fileSignature: fileSignature,
      detectedFormat: detected,
      parserUsed: parserUsed,
      extractionConfidence: parserUsed === "parser-26.x" ? "unvalidated-position-stream" : "none",
      reason: reason
    };
  }

  function unsupportedFormat(input, reason, details) {
    input = input || {};
    var detection = detectFormat(input);
    detection.parserUsed = "unsupportedFormat";
    detection.extractionConfidence = "none";
    detection.failures = [reason || detection.reason];
    if (details) detection.details = details;
    return { success: false, reason: detection.failures[0], formatDetection: detection, samples: [], capabilities: { position: false, bounds: false, scale: false, rotation: false } };
  }

  function parse26Tracker(parameter, metadata) {
    metadata = metadata || {};
    var payloadByteLengths = {};
    if (parameter && parameter.keys) {
      for (var keyIndex = 0; keyIndex < parameter.keys.length; keyIndex++) {
        var byteLength = parameter.keys[keyIndex].blob ? parameter.keys[keyIndex].blob.length : 0;
        payloadByteLengths[byteLength] = (payloadByteLengths[byteLength] || 0) + 1;
      }
    }
    var detection = detectFormat({
      premiereVersion: metadata.premiereVersion,
      fileSignature: metadata.fileSignature,
      projectIsGzipXml: metadata.projectIsGzipXml,
      projectIsXml: metadata.projectIsXml,
      matchName: metadata.matchName || TRACKER_MATCH_NAME,
      payloadByteLengths: payloadByteLengths
    });
    if (detection.parserUsed !== "parser-26.x") {
      return unsupportedFormat({
        premiereVersion: metadata.premiereVersion,
        fileSignature: metadata.fileSignature,
        projectIsGzipXml: metadata.projectIsGzipXml,
        projectIsXml: metadata.projectIsXml,
        matchName: metadata.matchName || TRACKER_MATCH_NAME,
        payloadByteLengths: payloadByteLengths
      }, detection.reason, { payloadByteLengths: payloadByteLengths });
    }
    if (!parameter || !parameter.keys || !parameter.keys.length) {
      return unsupportedFormat(metadata, "The selected AEMask2 Tracker parameter has no keyframed samples.");
    }

    var samples = [];
    for (var i = 0; i < parameter.keys.length; i++) {
      var key = parameter.keys[i];
      if (!key.blob || key.blob.length !== TRACKER_SAMPLE_BYTES) {
        return unsupportedFormat(metadata, "A Tracker record did not match the 104-byte layout.", { sampleIndex: i, byteLength: key.blob ? key.blob.length : null });
      }
      var x = key.blob.readFloatLE(64);
      var y = key.blob.readFloatLE(68);
      var a = key.blob.readFloatLE(4);
      var b = key.blob.readFloatLE(8);
      var c = key.blob.readFloatLE(16);
      var d = key.blob.readFloatLE(20);
      var determinant = a * d - b * c;
      var affineScaleEstimate = Math.sqrt(Math.abs(determinant));
      if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 5 || Math.abs(y) > 5) {
        return unsupportedFormat(metadata, "A Tracker sample contained a non-finite or implausible point value.", { sampleIndex: i, x: x, y: y });
      }
      samples.push({
        ticks: key.ticksText,
        sourceTime: key.ticks / TICKS_PER_SECOND,
        x: x,
        y: y,
        affineMatrix: [a, b, c, d],
        affineScaleEstimate: isFinite(affineScaleEstimate) && affineScaleEstimate > 0 ? affineScaleEstimate : null,
        affineScaleConfidence: "unvalidated"
      });
    }
    // In the observed 26.x stream the first all-zero point is an uninitialized
    // identity sample. Require both the zero point and identity matrix so a
    // genuine point at the source origin is not dropped solely by its XY.
    if (samples.length > 1 && samples[0].x === 0 && samples[0].y === 0 &&
        samples[0].affineMatrix[0] === 1 && samples[0].affineMatrix[1] === 0 &&
        samples[0].affineMatrix[2] === 0 && samples[0].affineMatrix[3] === 1 &&
        (samples[1].x !== 0 || samples[1].y !== 0)) samples.shift();

    if (samples.length < 2) return unsupportedFormat(metadata, "At least two usable point samples are required to form a trajectory.");
    return {
      success: true,
      samples: samples,
      payloadByteLengths: payloadByteLengths,
      capabilities: { position: true, bounds: false, scale: false, rotation: false },
      formatDetection: {
        premiereVersion: detection.premiereVersion,
        fileSignature: detection.fileSignature,
        detectedFormat: detection.detectedFormat,
        parserUsed: detection.parserUsed,
        extractionConfidence: "unvalidated-position-stream",
        frameCount: samples.length,
        failures: [],
        reason: "XY is decoded from the selected AEMask2 Tracker stream. Bounds, semantic center, and object size are not decoded; affine scale remains an unvalidated diagnostic estimate."
      }
    };
  }

  function detectSidecar(bytes) {
    if (!bytes || bytes.length < 8) return { signature: "unknown", version: null, parserUsed: "unsupportedFormat" };
    var magic = bytes.slice(0, 4).toString("ascii");
    var version = bytes.readUInt32LE(4);
    if (magic === "prmf" && version === 3) return { signature: "prmf/v3", version: 3, parserUsed: "header-only" };
    return { signature: "unknown", version: version, parserUsed: "unsupportedFormat" };
  }

  function readU64LE(buffer, offset) {
    return buffer.readUInt32LE(offset) + buffer.readUInt32LE(offset + 4) * 4294967296;
  }

  function flatTable(buffer, table, lower, upper) {
    if (table < lower + 4 || table + 4 > upper) return null;
    var distance = buffer.readInt32LE(table);
    if (!distance) return null;
    var vtable = table - distance;
    if (vtable < lower || vtable + 4 > upper) return null;
    var vtableBytes = buffer.readUInt16LE(vtable);
    var objectBytes = buffer.readUInt16LE(vtable + 2);
    if (vtableBytes < 4 || vtableBytes % 2 || objectBytes < 4 ||
        vtable + vtableBytes > upper || table + objectBytes > upper) return null;
    var fields = [];
    for (var i = 0; i < (vtableBytes - 4) / 2; i++) {
      var field = buffer.readUInt16LE(vtable + 4 + i * 2);
      if (field && (field < 4 || field >= objectBytes)) return null;
      fields.push(field);
    }
    return { tableOffset: table, vtableOffset: vtable, vtableBytes: vtableBytes, objectBytes: objectBytes, fields: fields };
  }

  function pointerTarget(buffer, pointerOffset, lower, upper) {
    if (pointerOffset < lower || pointerOffset + 4 > upper) return null;
    var target = pointerOffset + buffer.readUInt32LE(pointerOffset);
    return target >= lower && target + 4 <= upper ? target : null;
  }

  function parsePrmfV3(bytes) {
    if (!bytes || bytes.length < 32 || bytes.toString("ascii", 0, 4) !== "prmf" || bytes.readUInt32LE(4) !== 3) {
      throw new Error("Sidecar is not an observed PRMF v3 file.");
    }
    var payloadEnd = bytes.readUInt32LE(8);
    var reservedU32 = bytes.readUInt32LE(12);
    var trailerBytes = readU64LE(bytes, 16);
    var payloadStart = readU64LE(bytes, 24);
    if (payloadStart < 32 || payloadStart > payloadEnd || payloadEnd > bytes.length || payloadEnd + trailerBytes !== bytes.length) {
      throw new Error("PRMF v3 header payload and trailer bounds are invalid.");
    }
    var trailerStart = payloadEnd;
    if (trailerStart + 4 > bytes.length) throw new Error("PRMF v3 trailer has no root table offset.");
    var root = pointerTarget(bytes, trailerStart, trailerStart, bytes.length);
    var rootLayout = root === null ? null : flatTable(bytes, root, trailerStart, bytes.length);
    if (!rootLayout || rootLayout.fields.length !== 3 || rootLayout.fields[0] !== 12 || rootLayout.fields[1] !== 8 || rootLayout.fields[2] !== 4 || rootLayout.objectBytes < 16) {
      throw new Error("PRMF v3 trailer root does not match the observed frame-index table.");
    }
    if (bytes.readUInt32LE(root + rootLayout.fields[0]) !== 3) throw new Error("PRMF v3 frame-index table version is unsupported.");
    var configPointer = root + rootLayout.fields[1];
    var configTable = pointerTarget(bytes, configPointer, trailerStart, bytes.length);
    var config = configTable === null ? null : flatTable(bytes, configTable, trailerStart, bytes.length);
    if (!config || config.fields.length !== 3 || config.fields[0] !== 8 || config.fields[1] !== 6 || config.fields[2] !== 7) {
      throw new Error("PRMF v3 trailer configuration table is not a registered shape.");
    }
    var vectorPointer = root + rootLayout.fields[2];
    var vector = pointerTarget(bytes, vectorPointer, trailerStart, bytes.length);
    if (vector === null) throw new Error("PRMF v3 frame vector pointer is invalid.");
    var count = bytes.readUInt32LE(vector);
    if (!count || count > 1000000 || vector + 4 + count * 4 > bytes.length) throw new Error("PRMF v3 frame vector count or bounds are invalid.");

    var frames = [];
    for (var frameIndex = 0; frameIndex < count; frameIndex++) {
      var element = vector + 4 + frameIndex * 4;
      var table = pointerTarget(bytes, element, trailerStart, bytes.length);
      var record = table === null ? null : flatTable(bytes, table, trailerStart, bytes.length);
      var fields = record && record.fields;
      var timedShape = fields && fields.length === 7 && fields[0] === 4 && fields[1] === 36 && fields[2] === 44 && fields[3] === 8 && fields[4] === 24 && fields[5] === 0 && fields[6] === 32;
      var untimedShape = fields && fields.length === 7 && fields[0] === 4 && fields[1] === 0 && fields[2] === 36 && fields[3] === 8 && fields[4] === 24 && fields[5] === 0 && fields[6] === 32;
      if (!record || (!timedShape && !untimedShape)) throw new Error("PRMF frame " + frameIndex + " does not match a registered seven-slot record shape.");
      var timeTicks = timedShape ? readU64LE(bytes, table + fields[1]) : null;
      var payloadOffset = readU64LE(bytes, table + fields[2]);
      var x = bytes.readUInt32LE(table + fields[3]);
      var y = bytes.readUInt32LE(table + fields[3] + 4);
      var width = bytes.readUInt32LE(table + fields[3] + 8);
      var height = bytes.readUInt32LE(table + fields[3] + 12);
      var sourceWidth = bytes.readUInt32LE(table + fields[4]);
      var sourceHeight = bytes.readUInt32LE(table + fields[4] + 4);
      var payloadBytes = bytes.readUInt32LE(table + fields[6]);
      if (!sourceWidth || !sourceHeight || !width || !height || x + width > sourceWidth || y + height > sourceHeight) {
        throw new Error("PRMF frame " + frameIndex + " has invalid rectangle geometry or source dimensions.");
      }
      if (payloadOffset < payloadStart || !payloadBytes || payloadOffset + payloadBytes > payloadEnd) throw new Error("PRMF frame " + frameIndex + " payload range is outside the declared payload region.");
      frames.push({ frame: frameIndex, vectorIndex: frameIndex, payloadIndex: null, timeTicks: timeTicks, timeStored: timeTicks !== null,
        payloadOffset: payloadOffset, payloadBytes: payloadBytes, left: x, top: y, right: x + width, bottom: y + height,
        centerX: x + width / 2, centerY: y + height / 2, width: width, height: height,
        sourceWidth: sourceWidth, sourceHeight: sourceHeight });
    }
    frames.sort(function (a, b) { return a.payloadOffset - b.payloadOffset; });
    var cursor = payloadStart;
    var storedTimestampCount = 0;
    for (var orderedIndex = 0; orderedIndex < frames.length; orderedIndex++) {
      var ordered = frames[orderedIndex];
      if (ordered.payloadOffset !== cursor) throw new Error("PRMF per-frame payload ranges have a gap or overlap.");
      cursor += ordered.payloadBytes;
      ordered.payloadIndex = orderedIndex;
      if (ordered.timeTicks !== null) {
        storedTimestampCount++;
      }
    }
    if (cursor !== payloadEnd) throw new Error("PRMF frame payload ranges do not exactly cover the declared payload region.");
    return { version: 3, fileBytes: bytes.length, reservedU32: reservedU32, payloadStart: payloadStart,
      payloadEnd: payloadEnd, payloadBytes: payloadEnd - payloadStart, trailerStart: trailerStart,
      trailerBytes: trailerBytes, frameCount: frames.length, storedTimestampCount: storedTimestampCount, frames: frames };
  }

  function decodeObjectMaskSidecars(inputs, expectedTimeTicks, metadata) {
    metadata = metadata || {};
    if (versionMajor(metadata.premiereVersion) !== 26) throw new Error("PRMF Object Mask geometry has only been validated on Premiere 26.x.");
    var sidecars = [];
    for (var i = 0; i < inputs.length; i++) {
      var sidecar = parsePrmfV3(inputs[i].bytes);
      sidecar.uuid = String(inputs[i].uuid || "").toLowerCase();
      sidecar.file = inputs[i].file || null;
      sidecars.push(sidecar);
    }
    var temporal = [], references = [];
    for (var s = 0; s < sidecars.length; s++) {
      // A single-record file is a reference record, even if it carries a time.
      // The multi-frame sidecar is the time series; mixing a separate reference
      // rectangle into frame 0 can create a false geometry conflict.
      if (sidecars[s].frameCount > 1) temporal.push(sidecars[s]);
      else references.push(sidecars[s]);
    }
    var expected = (expectedTimeTicks || []).map(function (value) { return Number(value); });
    if (!expected.length) throw new Error("Saved-project source frame timing is required to validate Object Mask frame coverage.");
    var expectedIndex = {};
    for (var e = 0; e < expected.length; e++) expectedIndex[String(expected[e])] = e;
    var frameDuration = expected.length > 1 ? expected[1] - expected[0] : null;
    if (!frameDuration || frameDuration <= 0) throw new Error("Saved-project frame duration is not usable for PRMF time matching.");
    var sidecarOffsets = [];
    var observedPayloadOffsets = {};
    function frameForTicks(ticks) {
      var relative = (Number(ticks) - expected[0]) / frameDuration;
      var frameIndex = Math.round(relative);
      // TrackItem InPoints can fall between source frame boundaries. Accept
      // the nearest frame only when the saved PRMF timestamps keep one stable
      // sub-frame phase and form a continuous frame sequence below.
      if (!isFinite(relative) || Math.abs(relative - frameIndex) > 0.5 - 1e-7) {
        throw new Error("A stored PRMF timestamp is not aligned to the saved source frame grid.");
      }
      return frameIndex;
    }
    for (var t = 0; t < temporal.length; t++) {
      if (!temporal[t].storedTimestampCount) continue;
      var timestampedOffsetCounts = {};
      var timestampedFrameCount = 0;
      var timestampGridResiduals = [];
      for (var f = 0; f < temporal[t].frames.length; f++) {
        var timedFrame = temporal[t].frames[f];
        if (timedFrame.timeTicks === null) continue;
        var gridFrame = frameForTicks(timedFrame.timeTicks);
        timestampGridResiduals.push((Number(timedFrame.timeTicks) - expected[0]) / frameDuration - gridFrame);
        var offset = gridFrame - timedFrame.payloadIndex;
        timestampedOffsetCounts[offset] = (timestampedOffsetCounts[offset] || 0) + 1;
        timestampedFrameCount++;
      }
      if (timestampGridResiduals.length > 1) {
        var minimumResidual = Math.min.apply(Math, timestampGridResiduals);
        var maximumResidual = Math.max.apply(Math, timestampGridResiduals);
        if (maximumResidual - minimumResidual > 0.05) {
          throw new Error("PRMF timestamps do not share a stable sub-frame offset from the saved source frames.");
        }
      }
      var localOffset = null;
      Object.keys(timestampedOffsetCounts).forEach(function (offsetKey) {
        if (localOffset === null || timestampedOffsetCounts[offsetKey] > timestampedOffsetCounts[localOffset]) localOffset = offsetKey;
      });
      // A single timestamp/payload-order outlier is allowed for timestamped
      // records, but such a stream cannot supply an offset for untimed rows
      // unless its modal offset is stable in at least 95% of its samples.
      if (localOffset !== null && timestampedOffsetCounts[localOffset] / timestampedFrameCount >= 0.95) {
        sidecarOffsets[t] = Number(localOffset);
        observedPayloadOffsets[String(localOffset)] = true;
      }
    }
    var inferredPayloadOffset = Object.keys(observedPayloadOffsets).length === 1 ? Number(Object.keys(observedPayloadOffsets)[0]) : null;
    var records = [];
    for (var ti = 0; ti < temporal.length; ti++) {
      var temporalSidecar = temporal[ti];
      var frameOffset = sidecarOffsets[ti];
      if (frameOffset === undefined || frameOffset === null) frameOffset = inferredPayloadOffset;
      for (var fi = 0; fi < temporalSidecar.frames.length; fi++) {
        var candidate = temporalSidecar.frames[fi];
        if (candidate.timeTicks === null && (frameOffset === undefined || frameOffset === null)) {
          throw new Error("An omitted PRMF timestamp cannot be inferred from one stable offset in another referenced sidecar.");
        }
        var expectedFrameIndex = candidate.timeTicks !== null ? frameForTicks(candidate.timeTicks) : (candidate.payloadIndex + frameOffset);
        if (expectedFrameIndex < 0 || expectedFrameIndex >= expected.length) continue;
        var expectedTicks = expected[expectedFrameIndex];
        if (candidate.timeTicks !== null) candidate.sourceTimeTicks = candidate.timeTicks;
        if (candidate.timeTicks === null) {
          candidate.timeInference = "payload index aligned by timestamped records and saved project frame grid";
        }
        candidate.timeTicks = expectedTicks;
        candidate.time = candidate.timeTicks / TICKS_PER_SECOND;
        candidate.sourceSidecarUuid = temporalSidecar.uuid;
        candidate.sourceFile = temporalSidecar.file;
        records.push(candidate);
      }
    }
    var byTime = {};
    records.forEach(function (record) {
      var key = String(record.timeTicks);
      if (!byTime[key]) byTime[key] = [];
      byTime[key].push(record);
    });
    var timeline = [];
    var tolerance = isFinite(Number(metadata.conflictTolerancePx)) ? Number(metadata.conflictTolerancePx) : 5;
    Object.keys(byTime).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (key) {
      var observations = byTime[key];
      var unique = {};
      observations.forEach(function (item) { unique[[item.left, item.top, item.right, item.bottom, item.sourceWidth, item.sourceHeight].join(":")] = item; });
      var distinct = Object.keys(unique).map(function (uniqueKey) { return unique[uniqueKey]; });
      var widthHeight = {};
      observations.forEach(function (item) { widthHeight[item.sourceWidth + "x" + item.sourceHeight] = true; });
      var dimensionsMatch = Object.keys(widthHeight).length === 1;
      var axes = ["left", "top", "right", "bottom"];
      var disagreement = 0;
      for (var axisIndex = 0; axisIndex < axes.length; axisIndex++) {
        var values = observations.map(function (item) { return item[axes[axisIndex]]; });
        disagreement = Math.max(disagreement, Math.max.apply(Math, values) - Math.min.apply(Math, values));
      }
      if (distinct.length > 1 && (!dimensionsMatch || disagreement > tolerance)) throw new Error("Referenced PRMF sidecars contain an unresolved rectangle conflict at " + key + " ticks.");
      var geometry = { left: 0, top: 0, right: 0, bottom: 0 };
      for (var a = 0; a < axes.length; a++) {
        var nums = distinct.map(function (item) { return item[axes[a]]; }).sort(function (left, right) { return left - right; });
        geometry[axes[a]] = nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
      }
      var chosen = observations[0];
      geometry.timeTicks = Number(key);
      geometry.time = Number(key) / TICKS_PER_SECOND;
      geometry.frame = expectedIndex[key];
      geometry.sourceWidth = chosen.sourceWidth;
      geometry.sourceHeight = chosen.sourceHeight;
      geometry.centerX = (geometry.left + geometry.right) / 2;
      geometry.centerY = (geometry.top + geometry.bottom) / 2;
      geometry.width = geometry.right - geometry.left;
      geometry.height = geometry.bottom - geometry.top;
      geometry.normalizedCenterX = geometry.centerX / geometry.sourceWidth;
      geometry.normalizedCenterY = geometry.centerY / geometry.sourceHeight;
      geometry.normalizedWidth = geometry.width / geometry.sourceWidth;
      geometry.normalizedHeight = geometry.height / geometry.sourceHeight;
      geometry.sourceSidecarUuids = observations.map(function (item) { return item.sourceSidecarUuid; }).filter(function (uuid, index, all) { return all.indexOf(uuid) === index; });
      geometry.sourceFrameCount = observations.length;
      timeline.push(geometry);
    });
    if (timeline.length < 2) throw new Error("Fewer than two Object Mask frames overlap the selected clip's source range.");
    var leadingMissingFrames = timeline[0].frame;
    var trailingMissingFrames = expected.length - 1 - timeline[timeline.length - 1].frame;
    if (leadingMissingFrames > 1 || trailingMissingFrames > 1) {
      throw new Error("PRMF frames leave more than one untracked frame at a clip boundary.");
    }
    var timelineDimensions = {};
    timeline.forEach(function (frame) { timelineDimensions[frame.sourceWidth + "x" + frame.sourceHeight] = true; });
    if (Object.keys(timelineDimensions).length !== 1) throw new Error("PRMF source dimensions change within the tracked timeline.");
    for (var timelineIndex = 1; timelineIndex < timeline.length; timelineIndex++) {
      if (timeline[timelineIndex].frame !== timeline[timelineIndex - 1].frame + 1) throw new Error("The Object Mask records have a gap inside the selected clip's tracked range.");
    }
    var referenceSidecars = references.map(function (item) { return { uuid: item.uuid, file: item.file, recordCount: item.frameCount,
      storedTimestampCount: item.storedTimestampCount, reason: "single-record PRMF sidecar is retained as a reference and excluded from temporal tracking" }; });
    return { success: true, samples: timeline, sidecars: sidecars, temporalSidecarCount: temporal.length,
      singleRecordReferences: referenceSidecars,
      untimedSingleRecordReferences: referenceSidecars.filter(function (item) { return !item.storedTimestampCount; }),
      formatDetection: { premiereVersion: metadata.premiereVersion, detectedFormat: "premiere-26.x-object-mask-prmf-v3-rectangle-records",
        parserUsed: "parser-26.x-prmf-v3-frame-rectangles", extractionConfidence: "validated-frame-geometry",
        frameCount: timeline.length, failures: [], reason: "PRMF v3 rectangle records have stable source-frame timing, continuous geometry, and passed independent position and scale controls; rotation is not decoded." },
      frameCoverage: { expectedSourceFrames: expected.length, decodedFrames: timeline.length,
        leadingMissingFrames: leadingMissingFrames, trailingMissingFrames: trailingMissingFrames },
      capabilities: { position: true, bounds: true, scale: true, rotation: false },
      payloadByteLengths: {}, referenceCandidateCount: references.reduce(function (sum, item) { return sum + item.frameCount; }, 0) };
  }

  global.ObjectTrackerObjectMaskParser = {
    detectFormat: detectFormat,
    detectMaskSubtype: detectMaskSubtype,
    detectSidecar: detectSidecar,
    parse26Tracker: parse26Tracker,
    parsePrmfV3: parsePrmfV3,
    decodeObjectMaskSidecars: decodeObjectMaskSidecars,
    parserVersions: { "26.x": "registered AEMask2 104-byte point parser and validated PRMF v3 Object Mask geometry parser", "27.x": "unsupported until independently validated" },
    unsupportedFormat: unsupportedFormat,
    constants: { trackerMatchName: TRACKER_MATCH_NAME, trackerSampleBytes: TRACKER_SAMPLE_BYTES, classicMaskPrivateDataHash: CLASSIC_MASK_PRIVATE_DATA_HASH }
  };
}(window));
