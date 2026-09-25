(function (global) {
  "use strict";

  var MAX_PROJECT_BYTES = 256 * 1024 * 1024;
  var MAX_XML_BYTES = 512 * 1024 * 1024;
  var TICKS_PER_SECOND = 254016000000;
  var TRACKER_MATCH_NAME = "AE.ADBE AEMask2";
  var PARSER = global.ObjectTrackerObjectMaskParser;

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

  function inspectSidecarFolder(projectPath, node) {
    var projectName = node.path.basename(projectPath, node.path.extname(projectPath));
    var directory = node.path.join(node.path.dirname(projectPath), projectName + " Masks");
    var report = { directoryPath: directory, exists: false, fileCount: 0, files: [], association: "sidecars are matched against UUIDs serialized in the selected Tracker start value" };
    try {
      if (!node.fs.statSync(directory).isDirectory()) return report;
      report.exists = true;
      var filenames = node.fs.readdirSync(directory);
      for (var i = 0; i < filenames.length; i++) {
        if (!/\.prmf$/i.test(filenames[i])) continue;
        var filePath = node.path.join(directory, filenames[i]);
        var stat = node.fs.statSync(filePath);
        var header = node.Buffer.alloc(8);
        var fd = node.fs.openSync(filePath, "r");
        try { node.fs.readSync(fd, header, 0, 8, 0); } finally { node.fs.closeSync(fd); }
        var detected = PARSER ? PARSER.detectSidecar(header) : { signature: "unknown", version: null, parserUsed: "unsupportedFormat" };
        report.files.push({ name: filenames[i], bytes: stat.size, signature: detected.signature, version: detected.version, parserUsed: detected.parserUsed });
      }
      report.fileCount = report.files.length;
    } catch (error) {
      report.error = String(error);
    }
    return report;
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

  function anyObjectBlock(xml, objectId) {
    var escapedId = String(objectId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var re = new RegExp("<([A-Za-z0-9_]+)\\b(?=[^>]*\\bObjectID=\"" + escapedId + "\")[^>]*>[\\s\\S]*?</\\1>");
    var match = re.exec(xml);
    return match ? match[0] : null;
  }

  function projectSourceFrameGrid(xml, trackItemId) {
    var escapedId = String(trackItemId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var itemRe = /<VideoClipTrackItem\b[^>]*>[\s\S]*?<\/VideoClipTrackItem>/g;
    var itemMatch, item = null;
    while ((itemMatch = itemRe.exec(xml)) !== null) {
      if (elementText(itemMatch[0], "ID") === String(trackItemId) || new RegExp("\\bObjectID=\"" + escapedId + "\"").test(itemMatch[0].substring(0, itemMatch[0].indexOf(">")))) {
        item = itemMatch[0];
        break;
      }
    }
    if (!item) throw new Error("Selected TrackItem is not present in the saved project XML.");
    var subclipRef = /<SubClip\b[^>]*ObjectRef=\"([^\"]+)\"/.exec(item);
    var subclip = subclipRef ? anyObjectBlock(xml, subclipRef[1]) : null;
    var clipRef = subclip && /<Clip\b[^>]*ObjectRef=\"([^\"]+)\"/.exec(subclip);
    var clip = clipRef ? anyObjectBlock(xml, clipRef[1]) : null;
    if (!clip) throw new Error("Selected TrackItem does not resolve to a saved source clip.");
    var inPointText = elementText(clip, "InPoint");
    var outPointText = elementText(clip, "OutPoint");
    if (!/^-?\d+$/.test(String(inPointText || "")) || !/^-?\d+$/.test(String(outPointText || ""))) throw new Error("Saved source clip has no valid InPoint and OutPoint.");
    var clipName = elementText(subclip || "", "Name") || elementText(clip, "Name");
    var frameDurations = [];
    var loggingRe = /<ClipLoggingInfo\b[^>]*>[\s\S]*?<\/ClipLoggingInfo>/g;
    var loggingMatch;
    while ((loggingMatch = loggingRe.exec(xml)) !== null) {
      if (elementText(loggingMatch[0], "ClipName") === clipName) {
        var rateText = elementText(loggingMatch[0], "MediaFrameRate");
        if (/^\d+$/.test(String(rateText || "")) && frameDurations.indexOf(Number(rateText)) < 0) frameDurations.push(Number(rateText));
      }
    }
    if (frameDurations.length !== 1 || frameDurations[0] <= 0) throw new Error("Saved project does not resolve one source MediaFrameRate for this clip.");
    var inPoint = Number(inPointText), outPoint = Number(outPointText), frameDuration = frameDurations[0];
    if (outPoint <= inPoint) throw new Error("Saved source clip range is invalid.");
    var expected = [];
    for (var tick = inPoint; tick < outPoint; tick += frameDuration) expected.push(tick);
    if (!expected.length || expected.length > 1000000) throw new Error("Saved source frame grid is empty or exceeds the supported limit.");
    return { inPointTicks: inPoint, outPointTicks: outPoint, frameDurationTicks: frameDuration, expectedSampleCount: expected.length, expectedTimes: expected };
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
      var startValue = /<StartKeyframeValue\b[^>]*>([\s\S]*?)<\/StartKeyframeValue>/.exec(match[3]);
      var sidecarReferences = [];
      if (startValue) {
        try {
          var decodedValue = BufferCtor.from(startValue[1].replace(/\s/g, ""), "base64").toString("utf8");
          var references = decodedValue.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
          sidecarReferences = references || [];
        } catch (decodeError) {}
      }
      return {
        id: match[2],
        type: match[1],
        name: elementText(match[3], "Name"),
        timeVarying: /<IsTimeVarying>true<\/IsTimeVarying>/.test(match[3]),
        keys: parseKeyframes(keyframes ? keyframes[1] : "", BufferCtor),
        sidecarReferences: sidecarReferences,
        sidecarReferenceCount: sidecarReferences.length
      };
    }
    return null;
  }

  function decimalTrackItemId(nodeId) {
    var value = String(nodeId === undefined || nodeId === null ? "" : nodeId).trim();
    if (!value) return null;
    if (/^0x[0-9a-f]+$/i.test(value)) return String(parseInt(value.substring(2), 16));
    if (/^[0-9]+$/.test(value)) return String(Number(value));
    if (/^[0-9a-f]+$/i.test(value) && /[a-f]/i.test(value)) return String(parseInt(value, 16));
    return null;
  }

  function trackerParametersOnMask(xml, maskId, BufferCtor, formatContext) {
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
          var decoded = PARSER
            ? PARSER.parse26Tracker(parameter, {
                premiereVersion: formatContext && formatContext.premiereVersion,
                fileSignature: formatContext && formatContext.fileSignature,
                projectIsGzipXml: formatContext && formatContext.projectIsGzipXml,
                projectIsXml: formatContext && formatContext.projectIsXml,
                matchName: TRACKER_MATCH_NAME
              })
            : { success: false, samples: [], reason: "Object Mask parser module did not load.", capabilities: { position: false, bounds: false, scale: false, rotation: false } };
          output.push({
            parameterId: parameter.id,
            parameterType: parameter.type,
            timeVarying: parameter.timeVarying,
            keyCount: parameter.keys.length,
            payloadByteLengths: decoded.payloadByteLengths || null,
            sidecarReferences: parameter.sidecarReferences || [],
            sidecarReferenceCount: parameter.sidecarReferenceCount || 0,
            componentId: components[c].id,
            decoded: decoded
          });
        }
      }
      // Classic AEMask2 components often serialize this as a self-closing tag.
      var privateData = /<PremiereFilterPrivateData\b([^>]*)\/?\s*>/.exec(components[c].xml);
      var privateDataHash = privateData ? attribute(privateData[1], "BinaryHash") : null;
      var classification = PARSER ? PARSER.detectMaskSubtype(privateDataHash) : "unconfirmed";
      for (var outputIndex = 0; outputIndex < output.length; outputIndex++) {
        if (output[outputIndex].componentId === components[c].id) {
          output[outputIndex].maskClassification = classification;
          output[outputIndex].privateDataBinaryHash = privateDataHash;
          var sidecarFiles = formatContext && formatContext.sidecarSummary && formatContext.sidecarSummary.files || [];
          var filenameByUuid = {};
          for (var sidecarIndex = 0; sidecarIndex < sidecarFiles.length; sidecarIndex++) filenameByUuid[String(sidecarFiles[sidecarIndex].name || "").replace(/\.prmf$/i, "").toLowerCase()] = sidecarFiles[sidecarIndex].name;
          output[outputIndex].sidecarMatches = [];
          for (var referenceIndex = 0; referenceIndex < output[outputIndex].sidecarReferences.length; referenceIndex++) {
            var reference = output[outputIndex].sidecarReferences[referenceIndex];
            var filename = filenameByUuid[String(reference).toLowerCase()];
            if (filename) output[outputIndex].sidecarMatches.push({ uuid: reference, filename: filename });
          }
          // Resolve and validate linked PRMF data for every Tracker component.
          // Premiere's private-data hash varies between masks and saves, so it
          // cannot safely decide whether this parameter has Object Mask data.
          if (output[outputIndex].sidecarMatches.length && PARSER && typeof PARSER.decodeObjectMaskSidecars === "function") {
            try {
              var sidecarInputs = [];
              for (var matchedIndex = 0; matchedIndex < output[outputIndex].sidecarMatches.length; matchedIndex++) {
                var matched = output[outputIndex].sidecarMatches[matchedIndex];
                var sidecarBytes = null;
                if (formatContext && typeof formatContext.readSidecar === "function") sidecarBytes = formatContext.readSidecar(matched.filename);
                else if (formatContext && formatContext.sidecarDataByUuid) sidecarBytes = formatContext.sidecarDataByUuid[String(matched.uuid).toLowerCase()];
                if (!sidecarBytes) throw new Error("Referenced PRMF sidecar could not be read: " + matched.filename);
                sidecarInputs.push({ uuid: matched.uuid, file: matched.filename, bytes: sidecarBytes });
              }
              var frameGrid = projectSourceFrameGrid(formatContext.projectXml || xml, formatContext.trackItemId);
              output[outputIndex].decoded = PARSER.decodeObjectMaskSidecars(sidecarInputs, frameGrid.expectedTimes, { premiereVersion: formatContext.premiereVersion, conflictTolerancePx: 5 });
              output[outputIndex].maskClassification = "object-mask";
              output[outputIndex].sidecarFrameGrid = frameGrid;
              output[outputIndex].formatDetection = output[outputIndex].decoded.formatDetection;
            } catch (sidecarError) {
              var sidecarFailureDetection = {
                premiereVersion: formatContext && formatContext.premiereVersion || null,
                fileSignature: formatContext && formatContext.fileSignature || "unknown",
                detectedFormat: "aemask2-tracker-start-value-with-prmf-uuid-references",
                parserUsed: "unsupportedFormat",
                extractionConfidence: "none",
                frameCount: null,
                failures: [String(sidecarError)],
                reason: "The linked PRMF records could not be matched safely to this clip."
              };
              output[outputIndex].decoded = {
                success: false,
                reason: String(sidecarError),
                formatDetection: sidecarFailureDetection,
                samples: [],
                capabilities: { position: false, bounds: false, scale: false, rotation: false }
              };
              output[outputIndex].formatDetection = sidecarFailureDetection;
            }
          }
        }
      }
    }
    return output;
  }

  function extractFromXml(xml, selectedClip, BufferCtor, context) {
    var trackItemId = decimalTrackItemId(selectedClip && selectedClip.nodeId);
    if (!trackItemId) return resultError("TRACK_ITEM_ID_UNAVAILABLE", "Premiere did not return a usable selected TrackItem nodeId.", { nodeId: selectedClip && selectedClip.nodeId });
    if (context) context.trackItemId = trackItemId;
    var trackItems = xml.match(/<VideoClipTrackItem\b[^>]*>[\s\S]*?<\/VideoClipTrackItem>/g) || [];
    var item = null;
    for (var i = 0; i < trackItems.length; i++) {
      var openingTag = trackItems[i].substring(0, trackItems[i].indexOf(">"));
      if (elementText(trackItems[i], "ID") === trackItemId || attribute(openingTag, "ObjectID") === trackItemId) { item = trackItems[i]; break; }
    }
    if (!item) return resultError("SAVED_ITEM_NOT_FOUND", "The selected timeline clip was not found in the saved project. Save the project and retry.", { nodeId: selectedClip.nodeId, resolvedTrackItemId: trackItemId });

    var selectionChainMatch = /<SelectionComponents\b[^>]*ObjectRef="([^"]+)"/.exec(item);
    if (!selectionChainMatch) return resultError("MASK_CHAIN_NOT_FOUND", "The selected timeline item has no serialized SelectionComponents chain.", { trackItemId: trackItemId });
    var chain = objectBlock(xml, "VideoComponentChain", selectionChainMatch[1]);
    if (!chain) return resultError("MASK_CHAIN_NOT_FOUND", "The saved project does not contain the selected item's component chain.", { chainId: selectionChainMatch[1] });

    var rootComponentIds = objectRefs(chain, "Component");
    var masks = [];
    var masksByComponent = {};
    for (var r = 0; r < rootComponentIds.length; r++) {
      var root = objectBlock(xml, "VideoFilterComponent", rootComponentIds[r]);
      if (!root) continue;
      var matchName = elementText(root, "MatchName");
      if (matchName !== TRACKER_MATCH_NAME) continue;
      var trackerParameters = trackerParametersOnMask(xml, rootComponentIds[r], BufferCtor, context);
      for (var m = 0; m < trackerParameters.length; m++) {
        var componentId = trackerParameters[m].componentId;
        var groupedMask = masksByComponent[componentId];
        if (!groupedMask) {
          var mask = objectBlock(xml, "VideoFilterComponent", componentId);
          if (!mask || elementText(mask, "MatchName") !== TRACKER_MATCH_NAME) continue;
          groupedMask = { componentId: componentId, instanceName: elementText(mask, "InstanceName"), classification: trackerParameters[m].maskClassification, trackerParameters: [] };
          masksByComponent[componentId] = groupedMask;
          masks.push(groupedMask);
        }
        if (trackerParameters[m].maskClassification === "object-mask") groupedMask.classification = "object-mask";
        else if (groupedMask.classification === "unconfirmed" && trackerParameters[m].maskClassification === "classic-mask") groupedMask.classification = "classic-mask";
        groupedMask.trackerParameters.push(trackerParameters[m]);
      }
    }

    var valid = [];
    masks.forEach(function (mask) {
      mask.trackerParameters.forEach(function (parameter) {
        var parsedObjectMask = parameter.decoded.formatDetection && parameter.decoded.formatDetection.parserUsed === "parser-26.x-prmf-v3-frame-rectangles";
        if (parameter.sidecarReferenceCount > 0 || mask.classification === "object-mask") {
          if (parsedObjectMask && parameter.decoded.samples && parameter.decoded.samples.length >= 2) valid.push({ mask: mask, parameter: parameter });
        } else if (parameter.decoded.samples && parameter.decoded.samples.length >= 2) valid.push({ mask: mask, parameter: parameter });
      });
    });
    if (!valid.length) {
      var hasObjectMask = masks.some(function (mask) { return mask.classification === "object-mask"; });
      var hasPrmfCandidates = masks.some(function (mask) { return mask.trackerParameters.some(function (parameter) { return parameter.sidecarReferenceCount > 0; }); });
      var prmfFailureReason = "";
      masks.some(function (mask) { return mask.trackerParameters.some(function (parameter) {
        var failures = parameter.formatDetection && parameter.formatDetection.failures;
        if (failures && failures.length) { prmfFailureReason = String(failures[0]); return true; }
        return false;
      }); });
      var failure = resultError("NO_DECODED_AEMASK2_MASK_TRACK", masks.length
        ? (hasObjectMask
          ? "An Object Mask component was found, but no PRMF v3 geometry passed the registered record, sidecar, and saved source-frame timing checks. No Object Mask frames were emitted."
          : hasPrmfCandidates
            ? "This clip's linked PRMF sidecars could not be used safely" + (prmfFailureReason ? ": " + prmfFailureReason : ".") + " No track was used."
            : "AEMask2 mask components are attached to this clip, but none contains tracker samples in the registered Premiere 26.x 104-byte format.")
        : "No AEMask2 mask component was found on this timeline item.", {
        trackItemId: trackItemId,
        premiereVersion: context && context.premiereVersion || null,
        masks: masks.map(function (mask) { return { componentId: mask.componentId, instanceName: mask.instanceName, classification: mask.classification, trackers: mask.trackerParameters.map(function (p) { return { parameterId: p.parameterId, keyCount: p.keyCount, sidecarReferenceCount: p.sidecarReferenceCount, sidecarReferences: p.sidecarReferences, sidecarMatches: p.sidecarMatches, payloadByteLengths: p.payloadByteLengths, reason: p.decoded.reason, formatDetection: p.formatDetection || p.decoded.formatDetection }; }) }; }),
        objectMaskClassification: hasObjectMask ? "object-mask" : "unconfirmed"
      });
      failure.objectMaskClassification = hasObjectMask ? "object-mask" : "unconfirmed";
      return failure;
    }
    if (valid.length > 1) {
      return resultError("MULTIPLE_TRACKED_MASKS", "More than one tracked AEMask2 mask belongs to this clip. Select a specific mask before extraction.", { candidates: valid.map(function (entry) { return { maskId: entry.mask.componentId, instanceName: entry.mask.instanceName, parameterId: entry.parameter.parameterId, samples: entry.parameter.decoded.samples.length }; }) });
    }

    var selected = valid[0];
    if (!global.ObjectTrackerTrackingPipeline) return resultError("TRACKING_NORMALIZER_UNAVAILABLE", "The tracking normalizer did not load; no keyframes were written.");
    var detectedSubtype = selected.mask.classification;
    var objectMaskPrmf = detectedSubtype === "object-mask" && selected.parameter.decoded.formatDetection && selected.parameter.decoded.formatDetection.parserUsed === "parser-26.x-prmf-v3-frame-rectangles";
    var normalizedData = objectMaskPrmf
      ? global.ObjectTrackerTrackingPipeline.normalizeObjectMaskSamples(selected.parameter.decoded.samples)
      : global.ObjectTrackerTrackingPipeline.normalizeAEMaskSamples(selected.parameter.decoded.samples);
    var samples = normalizedData.samples;
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

    var extractionMessage = objectMaskPrmf
      ? "Decoded validated per-frame Object Mask rectangles from the selected PRMF v3 sidecars."
      : detectedSubtype === "object-mask"
      ? "Decoded the selected Object Mask component's AEMask2 point stream. Per-frame mask bounds and visual correlation are not validated."
      : detectedSubtype === "classic-mask"
        ? "Decoded the selected classic AEMask2 tracker point stream. This does not establish Object Mask compatibility."
        : "Decoded the selected AEMask2 tracker point stream; its mask subtype is unconfirmed.";
    return {
      success: true,
      stage: "extract-saved-mask-track",
      code: objectMaskPrmf ? "OBJECT_MASK_PRMF_TRACK_EXTRACTED" : "AEMASK2_POINT_TRACK_EXTRACTED",
      message: extractionMessage,
      source: "Premiere AEMask2 mask tracker",
      objectMaskClassification: detectedSubtype,
      premiereVersion: context && context.premiereVersion || null,
      formatDetection: selected.parameter.decoded.formatDetection,
      sidecarSummary: context && context.sidecarSummary || null,
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
      trackerParameter: { id: selected.parameter.parameterId, keyCount: selected.parameter.keyCount, decodedSampleCount: samples.length, frameCoverage: selected.parameter.decoded.frameCoverage || null, payloadBytes: objectMaskPrmf ? null : PARSER.constants.trackerSampleBytes, streamFormat: objectMaskPrmf ? "PRMF v3 frame rectangles" : "AEMask2 Tracker / 104-byte samples", privateDataBinaryHash: selected.parameter.privateDataBinaryHash, sidecarReferenceCount: selected.parameter.sidecarReferenceCount, temporalSidecarCount: selected.parameter.decoded.temporalSidecarCount || null, untimedReferenceCandidates: selected.parameter.decoded.untimedSingleRecordReferences || [] },
      timeMapping: hasTimeMapping ? { ticksPerSecond: TICKS_PER_SECOND, timelineRate: timelineRate, method: "clip start + (tracker source tick - TrackItem in-point) × TrackItem timeline/source duration ratio" } : null,
      normalizedTrack: {
        source: {
          source: objectMaskPrmf ? "Premiere Object Mask PRMF v3" : "Premiere AEMask2 mask tracker",
          streamFormat: objectMaskPrmf ? "Premiere 26.x Object Mask / PRMF v3 frame rectangles" : "AE.ADBE AEMask2 Tracker / 104-byte samples",
          maskSubtypeClassification: selected.mask.classification,
          sourceClipName: selectedClip.name,
          sourceNodeId: String(selectedClip.nodeId),
          sequenceId: context && context.sequenceId ? String(context.sequenceId) : null,
          projectPath: context && context.projectPath ? String(context.projectPath) : null,
          sourceWidth: objectMaskPrmf ? Number(samples[0].sourceWidth) : (Number(selectedClip.sourceWidth) || Number(context && context.sequenceFrameWidth) || null),
          sourceHeight: objectMaskPrmf ? Number(samples[0].sourceHeight) : (Number(selectedClip.sourceHeight) || Number(context && context.sequenceFrameHeight) || null),
          sourceDimensionsAssumedFromSequence: objectMaskPrmf ? false : !(Number(selectedClip.sourceWidth) > 0 && Number(selectedClip.sourceHeight) > 0),
          sequenceWidth: Number(context && context.sequenceFrameWidth) || null,
          sequenceHeight: Number(context && context.sequenceFrameHeight) || null,
          motionScale: Number(selectedClip.motionScale) || 100
        },
        capabilities: normalizedData.capabilities,
        representation: normalizedData.representation,
        extractionConfidence: normalizedData.extractionConfidence,
        sourceClipName: selectedClip.name,
        sampleCount: samples.length,
        reference: { x: first.x, y: first.y },
        samples: samples,
        sequenceStart: firstSequenceTime
      }
    };
  }

  function extractSelected(callback) {
    global.ObjectTrackerBridge.call("saveProject", function (saveResult) {
      if (!saveResult || !saveResult.success) { callback(saveResult || resultError("PROJECT_SAVE_FAILED", "Premiere did not confirm that the project was saved.")); return; }
      global.ObjectTrackerBridge.call("savedProjectContext", function (context) {
      if (!context || !context.success) { callback(context || resultError("NO_PROJECT_CONTEXT", "Premiere did not return project context.")); return; }
      if (!context.projectPath) { callback(resultError("PROJECT_NOT_SAVED", "Save the Premiere project before extracting a saved mask track.")); return; }
      var selected = context.selectedVideoClips || [];
      if (selected.length !== 1) { callback(resultError(selected.length ? "SELECT_ONE_VIDEO_CLIP" : "NO_SELECTED_VIDEO_CLIP", selected.length ? "Select exactly one video timeline clip containing the tracked mask." : "Select the timeline clip containing the tracked mask.")); return; }
      var node = getNodeModules();
      if (node.error) { callback(resultError("CEP_NODE_UNAVAILABLE", "Could not read the saved Premiere project because CEP Node access is unavailable.", node.error)); return; }
      try {
        var stat = node.fs.statSync(context.projectPath);
        if (stat.size > MAX_PROJECT_BYTES) { callback(resultError("PROJECT_TOO_LARGE", "The saved project exceeds the 256 MiB scan limit.", { bytes: stat.size })); return; }
        var decoded = decodeXml(node.fs.readFileSync(context.projectPath), node.zlib);
        context.fileSignature = decoded.compressed ? "gzip" : "xml";
        context.projectIsGzipXml = decoded.compressed;
        context.projectIsXml = true;
        context.sidecarSummary = inspectSidecarFolder(context.projectPath, node);
        context.projectXml = decoded.xml;
        context.trackItemId = context.selectedVideoClips[0].nodeId;
        context.readSidecar = function (filename) { return node.fs.readFileSync(node.path.join(context.sidecarSummary.directoryPath, filename)); };
        var result = extractFromXml(decoded.xml, selected[0], node.Buffer, context);
        result.sidecarSummary = context.sidecarSummary;
        result.projectName = node.path.basename(context.projectPath);
        result.encoding = decoded.compressed ? "gzip-compressed XML" : "XML";
        result.fileSignature = context.fileSignature;
        result.decodedBytes = decoded.decodedBytes;
        result.projectDirty = context.projectDirty;
        callback(result);
      } catch (error) { callback(resultError("PROJECT_READ_OR_PARSE_FAILED", "Could not read or parse the saved Premiere project.", String(error))); }
      });
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
