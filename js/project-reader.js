(function (global) {
  "use strict";

  var MAX_PROJECT_BYTES = 256 * 1024 * 1024;
  var MAX_XML_BYTES = 512 * 1024 * 1024;
  var TICKS_PER_SECOND = 254016000000;
  var TRACKER_MATCH_NAME = "AE.ADBE AEMask2";
  var TRACKER_SAMPLE_BYTES = 104;
  var X_OFFSET = 64;
  var Y_OFFSET = 68;

  function resultError(code, message, details, stage) {
    var result = { success: false, stage: stage || "extract-saved-mask-track", code: code, message: message };
    if (details) result.details = details;
    return result;
  }

  function getNodeModules() {
    try {
      var node = global.cep_node;
      if (node && typeof node.require === "function") {
        return { fs: node.require("fs"), path: node.require("path"), zlib: node.require("zlib"), Buffer: node.require("buffer").Buffer };
      }
    } catch (error) { return { error: String(error) }; }
    return { error: "CEP Node access is unavailable." };
  }

  function decodeXml(bytes, zlib) {
    var xmlBytes = bytes;
    var compressed = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (compressed) xmlBytes = zlib.gunzipSync(bytes, { maxOutputLength: MAX_XML_BYTES });
    if (xmlBytes.length > MAX_XML_BYTES) throw new Error("Decompressed project XML exceeds the 512 MiB scan limit.");
    var xml = xmlBytes.toString("utf8").replace(/^\uFEFF/, "");
    if (xml.indexOf("<") < 0 || !/<[A-Za-z_]/.test(xml)) throw new Error("The saved project did not decode to XML text.");
    return { xml: xml, compressed: compressed, decodedBytes: xmlBytes.length };
  }

  function xmlText(value) {
    return String(value || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }

  function attribute(tag, name) {
    var match = new RegExp("\\b" + name + '="([^"]*)"').exec(tag);
    return match ? xmlText(match[1]) : null;
  }

  function elementText(body, tagName) {
    var match = new RegExp("<" + tagName + "\\b[^>]*>([\\s\\S]*?)<\\/" + tagName + ">").exec(body || "");
    return match ? xmlText(match[1].trim()) : null;
  }

  function objectBlock(xml, tagName, objectId) {
    var re = new RegExp("<" + tagName + "\\b(?=[^>]*\\bObjectID=\"" + objectId + "\")[^>]*>[\\s\\S]*?<\\/" + tagName + ">");
    var match = re.exec(xml);
    return match ? match[0] : null;
  }

  function objectRefs(body, tagName) {
    var refs = [];
    var re = new RegExp("<" + tagName + "\\b[^>]*ObjectRef=\"([^\"]+)\"[^>]*/?>", "g");
    var match;
    while ((match = re.exec(body || "")) !== null) refs.push(match[1]);
    return refs;
  }

  function parseKeyframes(text, BufferCtor) {
    var keys = [];
    var entries = String(text || "").trim().split(";");
    for (var i = 0; i < entries.length; i++) {
      var comma = entries[i].indexOf(",");
      if (comma <= 0) continue;
      var tickText = entries[i].substring(0, comma).trim();
      var encoded = entries[i].substring(comma + 1).replace(/\s/g, "");
      if (!/^-?\d+$/.test(tickText) || !encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) continue;
      try {
        var blob = BufferCtor.from(encoded, "base64");
        if (blob.length) keys.push({ ticksText: tickText, ticks: Number(tickText), blob: blob });
      } catch (error) {}
    }
    keys.sort(function (a, b) { return a.ticks - b.ticks; });
    return keys;
  }

  function parseParameter(xml, parameterId, BufferCtor) {
    var re = /<([A-Za-z0-9_]*ComponentParam)\b[^>]*ObjectID="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
    var match;
    while ((match = re.exec(xml)) !== null) {
      if (match[2] !== String(parameterId)) continue;
      var keyframes = /<Keyframes>([\s\S]*?)<\/Keyframes>/.exec(match[3]);
      return {
        id: match[2],
        type: match[1],
        name: elementText(match[3], "Name"),
        timeVarying: /<IsTimeVarying>true<\/IsTimeVarying>/.test(match[3]),
        keys: parseKeyframes(keyframes ? keyframes[1] : "", BufferCtor)
      };
    }
    return null;
  }

  function decodeTracker(parameter) {
    if (!parameter || !parameter.keys.length) return { samples: [], reason: "No keyframed Tracker stream was stored for this mask." };
    var lengths = {};
    parameter.keys.forEach(function (key) { lengths[key.blob.length] = (lengths[key.blob.length] || 0) + 1; });
    var lengthKeys = Object.keys(lengths);
    if (lengthKeys.length !== 1 || Number(lengthKeys[0]) !== TRACKER_SAMPLE_BYTES) {
      return { samples: [], reason: "Tracker payload layout is unrecognized; expected fixed 104-byte AEMask2 samples.", payloadByteLengths: lengths };
    }
    var samples = [];
    for (var i = 0; i < parameter.keys.length; i++) {
      var key = parameter.keys[i];
      var x = key.blob.readFloatLE(X_OFFSET);
      var y = key.blob.readFloatLE(Y_OFFSET);
      if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 5 || Math.abs(y) > 5) {
        return { samples: [], reason: "Tracker sample contained a non-finite or implausible XY value.", badKeyIndex: i };
      }
      samples.push({ ticks: key.ticksText, sourceTime: key.ticks / TICKS_PER_SECOND, x: x, y: y });
    }
    // The observed AEMask2 stream starts with an uninitialized (0,0) sample;
    // the following samples contain its normalized tracker point. The saved
    // stream does not identify whether the mask is classic or Object Mask.
    if (samples.length > 1 && samples[0].x === 0 && samples[0].y === 0 && (samples[1].x !== 0 || samples[1].y !== 0)) {
      samples.shift();
    }
    if (samples.length < 2) return { samples: [], reason: "At least two valid XY samples are required to form motion." };
    return { samples: samples, payloadByteLengths: lengths };
  }

  function decimalTrackItemId(nodeId) {
    var value = String(nodeId === undefined || nodeId === null ? "" : nodeId).trim();
    if (!value) return null;
    if (/^0x[0-9a-f]+$/i.test(value)) return String(parseInt(value.substring(2), 16));
    if (/^[0-9]+$/.test(value)) return String(Number(value));
    if (/^[0-9a-f]+$/i.test(value) && /[a-f]/i.test(value)) return String(parseInt(value, 16));
    return null;
  }

  function trackerParametersOnMask(xml, maskId, BufferCtor) {
    var mask = objectBlock(xml, "VideoFilterComponent", maskId);
    if (!mask || elementText(mask, "MatchName") !== TRACKER_MATCH_NAME) return [];
    var subIds = objectRefs(mask, "SubComponent");
    // Some Premiere projects serialize mask values directly in the component;
    // others put the actual per-mask parameters in a nested SubComponent.
    var components = [{ id: maskId, xml: mask }];
    for (var i = 0; i < subIds.length; i++) {
      var sub = objectBlock(xml, "VideoFilterComponent", subIds[i]);
      if (sub && elementText(sub, "MatchName") === TRACKER_MATCH_NAME) components.push({ id: subIds[i], xml: sub });
    }
    var output = [];
    for (var c = 0; c < components.length; c++) {
      var paramIds = objectRefs(components[c].xml, "Param");
      for (var p = 0; p < paramIds.length; p++) {
        var parameter = parseParameter(xml, paramIds[p], BufferCtor);
        if (parameter && /^tracker$/i.test(parameter.name || "")) {
          var decoded = decodeTracker(parameter);
          output.push({
            parameterId: parameter.id,
            parameterType: parameter.type,
            timeVarying: parameter.timeVarying,
            keyCount: parameter.keys.length,
            payloadByteLengths: decoded.payloadByteLengths || null,
            componentId: components[c].id,
            decoded: decoded
          });
        }
      }
    }
    return output;
  }

  function extractFromXml(xml, selectedClip, BufferCtor, context) {
    var trackItemId = decimalTrackItemId(selectedClip && selectedClip.nodeId);
    if (!trackItemId) return resultError("TRACK_ITEM_ID_UNAVAILABLE", "Premiere did not return a usable selected TrackItem nodeId.", { nodeId: selectedClip && selectedClip.nodeId });
    var trackItems = xml.match(/<VideoClipTrackItem\b[^>]*>[\s\S]*?<\/VideoClipTrackItem>/g) || [];
    var item = null;
    for (var i = 0; i < trackItems.length; i++) {
      if (elementText(trackItems[i], "ID") === trackItemId) { item = trackItems[i]; break; }
    }
    if (!item) return resultError("SAVED_ITEM_NOT_FOUND", "The selected timeline clip was not found in the saved project. Save the project and retry.", { nodeId: selectedClip.nodeId, resolvedTrackItemId: trackItemId });

    var selectionChainMatch = /<SelectionComponents\b[^>]*ObjectRef="([^"]+)"/.exec(item);
    if (!selectionChainMatch) return resultError("MASK_CHAIN_NOT_FOUND", "The selected timeline item has no serialized SelectionComponents chain.", { trackItemId: trackItemId });
    var chain = objectBlock(xml, "VideoComponentChain", selectionChainMatch[1]);
    if (!chain) return resultError("MASK_CHAIN_NOT_FOUND", "The saved project does not contain the selected item's component chain.", { chainId: selectionChainMatch[1] });

    var rootComponentIds = objectRefs(chain, "Component");
    var masks = [];
    var visited = {};
    for (var r = 0; r < rootComponentIds.length; r++) {
      var root = objectBlock(xml, "VideoFilterComponent", rootComponentIds[r]);
      if (!root) continue;
      var matchName = elementText(root, "MatchName");
      if (matchName !== TRACKER_MATCH_NAME) continue;
      var trackerParameters = trackerParametersOnMask(xml, rootComponentIds[r], BufferCtor);
      for (var m = 0; m < trackerParameters.length; m++) {
        var componentId = trackerParameters[m].componentId;
        if (visited[componentId]) continue;
        visited[componentId] = true;
        var mask = objectBlock(xml, "VideoFilterComponent", componentId);
        if (!mask || elementText(mask, "MatchName") !== TRACKER_MATCH_NAME) continue;
        masks.push({ componentId: componentId, instanceName: elementText(mask, "InstanceName"), trackerParameters: [trackerParameters[m]] });
      }
    }

    var valid = [];
    masks.forEach(function (mask) {
      mask.trackerParameters.forEach(function (parameter) {
        if (parameter.decoded.samples && parameter.decoded.samples.length >= 2) valid.push({ mask: mask, parameter: parameter });
      });
    });
    if (!valid.length) {
      return resultError("NO_DECODED_AEMASK2_MASK_TRACK", masks.length
        ? "AEMask2 mask components are attached to this clip, but none contains a tracker stream in the verified 104-byte format."
        : "No AEMask2 mask component was found on this timeline item.", {
        trackItemId: trackItemId,
        masks: masks.map(function (mask) { return { componentId: mask.componentId, instanceName: mask.instanceName, trackers: mask.trackerParameters.map(function (p) { return { parameterId: p.parameterId, keyCount: p.keyCount, payloadByteLengths: p.payloadByteLengths, reason: p.decoded.reason }; }) }; }),
        objectMaskClassification: "unconfirmed"
      });
    }
    if (valid.length > 1) {
      return resultError("MULTIPLE_TRACKED_MASKS", "More than one tracked AEMask2 mask belongs to this clip. Select a specific mask before extraction.", { candidates: valid.map(function (entry) { return { maskId: entry.mask.componentId, instanceName: entry.mask.instanceName, parameterId: entry.parameter.parameterId, samples: entry.parameter.decoded.samples.length }; }) });
    }

    var selected = valid[0];
    var samples = selected.parameter.decoded.samples;
    var startTicks = Number(selectedClip.start);
    var endTicks = Number(selectedClip.end);
    var inPointTicks = Number(selectedClip.inPoint);
    var outPointTicks = Number(selectedClip.outPoint);
    var hasTimeMapping = [startTicks, endTicks, inPointTicks, outPointTicks].every(function (n) { return isFinite(n); }) && outPointTicks > inPointTicks;
    var timelineRate = hasTimeMapping ? ((endTicks - startTicks) / (outPointTicks - inPointTicks)) : 1;
    var first = samples[0];
    var firstSequenceTime = hasTimeMapping ? (startTicks + (first.sourceTime * TICKS_PER_SECOND - inPointTicks) * timelineRate) / TICKS_PER_SECOND : null;
    var prevTick = null;
    for (var s = 0; s < samples.length; s++) {
      var sample = samples[s];
      sample.dx = sample.x - first.x;
      sample.dy = sample.y - first.y;
      sample.time = sample.sourceTime - first.sourceTime;
      sample.sequenceTime = hasTimeMapping ? (startTicks + (Number(sample.ticks) - inPointTicks) * timelineRate) / TICKS_PER_SECOND : null;
      sample.timeFromTrackStart = hasTimeMapping ? sample.sequenceTime - firstSequenceTime : sample.time;
      if (prevTick !== null && Number(sample.ticks) <= prevTick) return resultError("NON_MONOTONIC_TRACK", "The selected tracker stream contains repeated or out-of-order timestamps.");
      prevTick = Number(sample.ticks);
    }

    return {
      success: true,
      stage: "extract-saved-mask-track",
      code: "AEMASK2_TRACK_EXTRACTED",
      message: "Extracted a tracked AEMask2 mask stream from the selected clip's saved component chain. Premiere's scripting data does not identify the mask subtype.",
      source: "Premiere AEMask2 mask tracker",
      objectMaskClassification: "unconfirmed",
      savedProjectReadOnly: true,
      sourceClip: {
        name: selectedClip.name,
        nodeId: String(selectedClip.nodeId),
        trackItemId: trackItemId,
        trackIndex: selectedClip.trackIndex,
        clipIndex: selectedClip.clipIndex,
        startTicks: selectedClip.start,
        endTicks: selectedClip.end,
        inPointTicks: selectedClip.inPoint,
        outPointTicks: selectedClip.outPoint,
        firstTrackedSourceTime: first.sourceTime,
        firstTrackedSequenceTime: firstSequenceTime
      },
      mask: { componentId: selected.mask.componentId, instanceName: selected.mask.instanceName },
      trackerParameter: { id: selected.parameter.parameterId, keyCount: selected.parameter.keyCount, decodedSampleCount: samples.length, payloadBytes: TRACKER_SAMPLE_BYTES, xOffset: X_OFFSET, yOffset: Y_OFFSET },
      timeMapping: hasTimeMapping ? { ticksPerSecond: TICKS_PER_SECOND, timelineRate: timelineRate, method: "clip start + (tracker source tick - TrackItem in-point) × TrackItem timeline/source duration ratio" } : null,
      normalizedTrack: {
        source: {
          source: "Premiere AEMask2 mask tracker",
          streamFormat: "AE.ADBE AEMask2 Tracker / 104-byte samples",
          maskSubtypeClassification: "unconfirmed",
          sourceClipName: selectedClip.name,
          sourceNodeId: String(selectedClip.nodeId),
          sequenceId: context && context.sequenceId ? String(context.sequenceId) : null,
          projectPath: context && context.projectPath ? String(context.projectPath) : null,
          sourceWidth: Number(selectedClip.sourceWidth) || Number(context && context.sequenceFrameWidth) || null,
          sourceHeight: Number(selectedClip.sourceHeight) || Number(context && context.sequenceFrameHeight) || null,
          sourceDimensionsAssumedFromSequence: !(Number(selectedClip.sourceWidth) > 0 && Number(selectedClip.sourceHeight) > 0),
          sequenceWidth: Number(context && context.sequenceFrameWidth) || null,
          sequenceHeight: Number(context && context.sequenceFrameHeight) || null,
          motionScale: Number(selectedClip.motionScale) || 100
        },
        sourceClipName: selectedClip.name,
        sampleCount: samples.length,
        reference: { x: first.x, y: first.y },
        samples: samples,
        sequenceStart: firstSequenceTime
      }
    };
  }

  function extractSelected(callback) {
    global.ObjectTrackerBridge.call("savedProjectContext", function (context) {
      if (!context || !context.success) { callback(context || resultError("NO_PROJECT_CONTEXT", "Premiere did not return project context.")); return; }
      if (context.projectDirty !== false) { callback(resultError(context.projectDirty === true ? "UNSAVED_PROJECT_CHANGES" : "PROJECT_DIRTY_STATE_UNKNOWN", "Save the Premiere project manually before extracting. The reader needs a confirmed clean saved project and never saves it.")); return; }
      if (!context.projectPath) { callback(resultError("PROJECT_NOT_SAVED", "Save the Premiere project before extracting a saved mask track.")); return; }
      var selected = context.selectedVideoClips || [];
      if (selected.length !== 1) { callback(resultError(selected.length ? "SELECT_ONE_VIDEO_CLIP" : "NO_SELECTED_VIDEO_CLIP", selected.length ? "Select exactly one video timeline clip containing the tracked mask." : "Select the timeline clip containing the tracked mask.")); return; }
      var node = getNodeModules();
      if (node.error) { callback(resultError("CEP_NODE_UNAVAILABLE", "Could not read the saved Premiere project because CEP Node access is unavailable.", node.error)); return; }
      try {
        var stat = node.fs.statSync(context.projectPath);
        if (stat.size > MAX_PROJECT_BYTES) { callback(resultError("PROJECT_TOO_LARGE", "The saved project exceeds the 256 MiB scan limit.", { bytes: stat.size })); return; }
        var decoded = decodeXml(node.fs.readFileSync(context.projectPath), node.zlib);
        var result = extractFromXml(decoded.xml, selected[0], node.Buffer, context);
        result.projectName = node.path.basename(context.projectPath);
        result.encoding = decoded.compressed ? "gzip-compressed XML" : "XML";
        result.decodedBytes = decoded.decodedBytes;
        result.projectDirty = context.projectDirty;
        callback(result);
      } catch (error) { callback(resultError("PROJECT_READ_OR_PARSE_FAILED", "Could not read or parse the saved Premiere project.", String(error))); }
    });
  }

  function inspectStreams(xml, BufferCtor) {
    var paramRe = /<([A-Za-z0-9_]*ComponentParam)\b[^>]*ObjectID="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
    var keyedParameterCount = 0, candidates = [], match;
    while ((match = paramRe.exec(xml)) !== null) {
      var keyframes = /<Keyframes>([\s\S]*?)<\/Keyframes>/.exec(match[3]);
      if (!keyframes) continue;
      keyedParameterCount++;
      var name = elementText(match[3], "Name");
      var keys = parseKeyframes(keyframes[1], BufferCtor);
      if (name && /tracker|mask|object/i.test(name)) candidates.push({ parameterId: match[2], parameterName: name, keyCount: keys.length, payloadByteLengths: keys.reduce(function (acc, key) { acc[key.blob.length] = (acc[key.blob.length] || 0) + 1; return acc; }, {}) });
    }
    return { keyedParameterCount: keyedParameterCount, candidateCount: candidates.length, candidates: candidates.slice(0, 80), candidatesTruncated: candidates.length > 80 };
  }

  function scan(callback) {
    global.ObjectTrackerBridge.call("savedProjectContext", function (context) {
      if (!context || !context.success) { callback(context || resultError("NO_PROJECT_CONTEXT", "Premiere did not return project context.", null, "saved-project-track-scan")); return; }
      if (context.projectDirty !== false) { callback(resultError(context.projectDirty === true ? "UNSAVED_PROJECT_CHANGES" : "PROJECT_DIRTY_STATE_UNKNOWN", "Save the Premiere project manually, then scan again. The scanner needs a confirmed clean saved project and never saves it.", null, "saved-project-track-scan")); return; }
      if (!context.projectPath) { callback(resultError("PROJECT_NOT_SAVED", "Save the Premiere project before scanning saved project data.", null, "saved-project-track-scan")); return; }
      var node = getNodeModules();
      if (node.error) { callback(resultError("CEP_NODE_UNAVAILABLE", "Could not read the saved project.", node.error, "saved-project-track-scan")); return; }
      try {
        var stat = node.fs.statSync(context.projectPath);
        if (stat.size > MAX_PROJECT_BYTES) { callback(resultError("PROJECT_TOO_LARGE", "The project exceeds the 256 MiB scan limit.", { bytes: stat.size }, "saved-project-track-scan")); return; }
        var decoded = decodeXml(node.fs.readFileSync(context.projectPath), node.zlib);
        var report = inspectStreams(decoded.xml, node.Buffer);
        callback({ success: true, stage: "saved-project-track-scan", message: "Read-only scan completed. Candidate streams are exploratory until associated with a selected TrackItem.", projectName: node.path.basename(context.projectPath), projectDirty: context.projectDirty, sequence: context.sequence, selectedVideoClips: context.selectedVideoClips, encoding: decoded.compressed ? "gzip-compressed XML" : "XML", decodedBytes: decoded.decodedBytes, keyedParameterCount: report.keyedParameterCount, candidateCount: report.candidateCount, candidatesTruncated: report.candidatesTruncated, candidates: report.candidates });
      } catch (error) { callback(resultError("PROJECT_READ_OR_PARSE_FAILED", "Could not read or scan the saved project file.", String(error), "saved-project-track-scan")); }
    });
  }

  global.ObjectTrackerProjectReader = { extractSelected: extractSelected, scan: scan, inspectStreams: inspectStreams, extractFromXml: extractFromXml, ticksPerSecond: TICKS_PER_SECOND };
}(window));
