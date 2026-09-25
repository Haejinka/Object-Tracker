$._ObjectTracker.findComponent = function (clip, options) {
    options = options || {};
    var matchNames = options.matchNames || [];
    var fallbackNames = options.displayNames || [];
    var components = $._ObjectTracker.read(clip, "components");
    var componentCount = components ? $._ObjectTracker.read(components, "numItems") : 0;
    var matches = [];

    for (var componentIndex = 0; componentIndex < componentCount; componentIndex++) {
        var component = $._ObjectTracker.read(components, componentIndex);
        if (!component) continue;
        var matchName = String($._ObjectTracker.read(component, "matchName") || "");
        var displayName = String($._ObjectTracker.read(component, "displayName") || "");
        var exactMatch = false;
        var nameMatch = false;

        for (var i = 0; i < matchNames.length; i++) {
            if (matchName === matchNames[i]) exactMatch = true;
        }
        for (var j = 0; j < fallbackNames.length; j++) {
            if (displayName.toLowerCase() === String(fallbackNames[j]).toLowerCase()) nameMatch = true;
        }
        if (exactMatch || nameMatch) {
            matches.push({ component: component, index: componentIndex, matchName: matchName, displayName: displayName, exactMatch: exactMatch });
        }
    }

    return { matches: matches };
};

$._ObjectTracker.findPositionParameter = function (component) {
    var properties = $._ObjectTracker.read(component, "properties");
    var propertyCount = properties ? $._ObjectTracker.read(properties, "numItems") : 0;
    var matches = [];
    for (var propertyIndex = 0; propertyIndex < propertyCount; propertyIndex++) {
        var parameter = $._ObjectTracker.read(properties, propertyIndex);
        if (!parameter) continue;
        var displayName = String($._ObjectTracker.read(parameter, "displayName") || "");
        if (displayName.toLowerCase() === "position") {
            matches.push({ parameter: parameter, index: propertyIndex });
        }
    }
    return matches;
};

$._ObjectTracker.inspectTransform = function (clip) {
    var transform = $._ObjectTracker.findComponent(clip, {
        matchNames: ["AE.ADBE Geometry", "AE.ADBE Geometry2"],
        displayNames: ["Transform"]
    });
    var output = {
        found: transform.matches.length > 0,
        matchStrategy: transform.matches.length ? (transform.matches[0].exactMatch ? "matchName" : "displayName fallback") : null,
        matches: []
    };

    for (var i = 0; i < transform.matches.length; i++) {
        var match = transform.matches[i];
        var positions = $._ObjectTracker.findPositionParameter(match.component);
        var componentReport = {
            componentIndex: match.index,
            displayName: match.displayName,
            matchName: match.matchName,
            positionParameterCount: positions.length,
            position: []
        };
        for (var p = 0; p < positions.length; p++) {
            var parameter = positions[p].parameter;
            var value = $._ObjectTracker.call(parameter, "getValue", []);
            componentReport.position.push({
                propertyIndex: positions[p].index,
                value: value.available && value.error === undefined
                    ? $._ObjectTracker.serializeValue(value.value, 0, [])
                    : (value.error || "getValue is not exposed"),
                keyframeStream: $._ObjectTracker.inspectKeyframeStream(parameter)
            });
        }
        output.matches.push(componentReport);
    }
    return output;
};

$._ObjectTracker.inspectSelectedTransform = function () {
    var sequence = $._ObjectTracker.getActiveSequence();
    var selection = $._ObjectTracker.getSelectedTrackItems(sequence);
    var report = {
        success: false,
        stage: "inspect-transform",
        sequence: sequence ? $._ObjectTracker.read(sequence, "name") : null,
        selectedCount: selection.items.length,
        selectedVideoCount: 0,
        targets: []
    };
    if (!sequence) {
        report.code = "NO_ACTIVE_SEQUENCE";
        report.message = "Open a sequence, then select one video clip to inspect its Transform component.";
        return JSON.stringify(report);
    }
    var videoItems = [];
    for (var selectedIndex = 0; selectedIndex < selection.items.length; selectedIndex++) {
        if (String($._ObjectTracker.read(selection.items[selectedIndex].clip, "mediaType")) === "Video") {
            videoItems.push(selection.items[selectedIndex]);
        }
    }
    report.selectedVideoCount = videoItems.length;
    if (videoItems.length !== 1) {
        report.code = videoItems.length === 0 ? "NO_SELECTED_VIDEO_CLIP" : "SELECT_ONE_VIDEO_CLIP";
        report.message = "Select one video clip to inspect its Transform component. Linked audio may remain selected.";
        return JSON.stringify(report);
    }
    report.targets.push($._ObjectTracker.inspectTransform(videoItems[0].clip));
    report.success = true;
    report.message = report.targets[0].found ? "Transform component inspected." : "No Transform component was found.";
    return JSON.stringify(report);
};

$._ObjectTracker.findPositionProperty = function (component) {
    var properties = $._ObjectTracker.read(component, "properties");
    var count = properties ? $._ObjectTracker.read(properties, "numItems") : 0;
    var matches = [];
    for (var i = 0; i < count; i++) {
        var parameter = $._ObjectTracker.read(properties, i);
        if (!parameter) continue;
        var name = String($._ObjectTracker.read(parameter, "displayName") || "").toLowerCase();
        var matchName = String($._ObjectTracker.read(parameter, "matchName") || "").toLowerCase();
        if (name === "position" || matchName === "position") matches.push(parameter);
    }
    return matches;
};

$._ObjectTracker.findScaleProperties = function (component) {
    var properties = $._ObjectTracker.read(component, "properties");
    var count = properties ? $._ObjectTracker.read(properties, "numItems") : 0;
    var matches = { width: [], height: [], uniform: [] };
    for (var i = 0; i < count; i++) {
        var parameter = $._ObjectTracker.read(properties, i);
        if (!parameter) continue;
        var name = String($._ObjectTracker.read(parameter, "displayName") || "").toLowerCase().replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
        if (name === "scale width") matches.width.push(parameter);
        else if (name === "scale height") matches.height.push(parameter);
        else if (name === "scale") matches.uniform.push(parameter);
    }
    return matches;
};

$._ObjectTracker.findTransformComponents = function (clip) {
    var components = $._ObjectTracker.read(clip, "components");
    var count = components ? $._ObjectTracker.read(components, "numItems") : 0;
    var matches = [];
    for (var i = 0; i < count; i++) {
        var component = $._ObjectTracker.read(components, i);
        if (!component) continue;
        var matchName = String($._ObjectTracker.read(component, "matchName") || "");
        var displayName = String($._ObjectTracker.read(component, "displayName") || "");
        if (matchName === "AE.ADBE Geometry2" || matchName === "AE.ADBE Geometry" || displayName.toLowerCase() === "transform") {
            matches.push({ component: component, matchName: matchName, displayName: displayName, index: i });
        }
    }
    return matches;
};

$._ObjectTracker.findMotionComponents = function (clip) {
    var components = $._ObjectTracker.read(clip, "components");
    var count = components ? $._ObjectTracker.read(components, "numItems") : 0;
    var matches = [];
    for (var i = 0; i < count; i++) {
        var component = $._ObjectTracker.read(components, i);
        if (!component) continue;
        var matchName = String($._ObjectTracker.read(component, "matchName") || "");
        var displayName = String($._ObjectTracker.read(component, "displayName") || "");
        if (matchName === "AE.ADBE Motion" || displayName.toLowerCase() === "motion") {
            matches.push({ component: component, matchName: matchName, displayName: displayName, index: i });
        }
    }
    return matches;
};

$._ObjectTracker.getSelectedVideoClip = function () {
    var sequence = $._ObjectTracker.getActiveSequence();
    var selection = $._ObjectTracker.getSelectedTrackItems(sequence);
    var videos = [];
    for (var i = 0; i < selection.items.length; i++) {
        if (String($._ObjectTracker.read(selection.items[i].clip, "mediaType")) === "Video") videos.push(selection.items[i]);
    }
    return { sequence: sequence, selection: selection, videos: videos };
};

$._ObjectTracker.addTransformWithQE = function (clip, trackIndex) {
    var qeApp = null;
    try { if (typeof app.enableQE === "function") app.enableQE(); } catch (enableError) {}
    try { if (typeof qe !== "undefined") qeApp = qe; } catch (qeError) {}
    if (!qeApp || !qeApp.project) return { success: false, code: "QE_UNAVAILABLE", message: "Premiere did not expose QE for adding the Transform effect. Add Transform to the target manually, then apply again." };

    var qeSequence = null, qeTrack = null;
    try { qeSequence = qeApp.project.getActiveSequence(); } catch (sequenceError) {}
    if (!qeSequence) return { success: false, code: "QE_SEQUENCE_UNAVAILABLE", message: "QE could not resolve the active sequence." };
    try { qeTrack = qeSequence.getVideoTrackAt(trackIndex); } catch (trackError) {}
    if (!qeTrack) return { success: false, code: "QE_TRACK_UNAVAILABLE", message: "QE could not resolve the selected clip's video track." };

    var targetStart = $._ObjectTracker.read($._ObjectTracker.read(clip, "start"), "seconds");
    var targetName = String($._ObjectTracker.read(clip, "name") || "");
    var qeClip = null;
    for (var i = 0; i < qeTrack.numItems; i++) {
        var candidate = null;
        try { candidate = qeTrack.getItemAt(i); } catch (itemError) {}
        if (!candidate) continue;
        var startTime = null;
        try { if (candidate.start && typeof candidate.start.secs === "number") startTime = candidate.start.secs; } catch (secsError) {}
        if (startTime === null) try { if (candidate.start && typeof candidate.start.seconds === "number") startTime = candidate.start.seconds; } catch (secondsError) {}
        var candidateName = "";
        try { candidateName = String(candidate.name || ""); } catch (nameError) {}
        if (startTime !== null && Math.abs(startTime - targetStart) < 0.0001 && (!candidateName || candidateName === targetName)) {
            if (qeClip) return { success: false, code: "QE_CLIP_AMBIGUOUS", message: "More than one QE clip matched the selected TrackItem's name and start time." };
            qeClip = candidate;
        }
    }
    if (!qeClip) return { success: false, code: "QE_CLIP_NOT_FOUND", message: "QE could not match the selected TrackItem by video track, clip name, and start time." };

    var effect = null;
    try { effect = qeApp.project.getVideoEffectByName("Transform"); } catch (effectError) {}
    if (!effect) return { success: false, code: "TRANSFORM_EFFECT_NOT_FOUND", message: "QE could not find the Transform effect by name. Add it manually or check Premiere's effect localization." };
    try { qeClip.addVideoEffect(effect); } catch (addError) { return { success: false, code: "TRANSFORM_ADD_FAILED", message: "QE could not add Transform to the selected clip.", details: String(addError) }; }

    var added = $._ObjectTracker.findTransformComponents(clip);
    if (added.length !== 1) return { success: false, code: added.length ? "TRANSFORM_ADD_AMBIGUOUS" : "TRANSFORM_ADDED_NOT_VISIBLE", message: added.length ? "Transform was added, but more than one Transform component is present; no keys were written." : "QE added an effect, but the public TrackItem component list did not expose it; no keys were written.", transformCount: added.length };
    return { success: true, added: true, component: added[0].component, matchName: added[0].matchName };
};

$._ObjectTracker.keySeconds = function (key) {
    if (typeof key === "number") return key;
    var seconds = $._ObjectTracker.read(key, "seconds");
    return typeof seconds === "number" ? seconds : null;
};

$._ObjectTracker.keyList = function (parameter) {
    var result = $._ObjectTracker.call(parameter, "getKeys", []);
    if (!result.available || result.error || !result.value || typeof result.value.length !== "number") {
        return { available: result.available, error: result.error || "Premiere did not return an array of key times.", keys: [] };
    }
    var keys = [];
    for (var i = 0; i < result.value.length; i++) keys.push(result.value[i]);
    return { available: true, keys: keys };
};

$._ObjectTracker.getTimeVarying = function (parameter) {
    var result = $._ObjectTracker.call(parameter, "isTimeVarying", []);
    return result.available && !result.error ? result.value === true : null;
};

$._ObjectTracker.allFiniteNumbers = function (values) {
    for (var i = 0; i < values.length; i++) if (!isFinite(values[i])) return false;
    return true;
};

$._ObjectTracker.findExactKey = function (keys, seconds, tolerance) {
    tolerance = tolerance || 0.000001;
    for (var i = 0; i < keys.length; i++) {
        var keySeconds = $._ObjectTracker.keySeconds(keys[i]);
        if (keySeconds !== null && Math.abs(keySeconds - seconds) <= tolerance) return keys[i];
    }
    return null;
};

$._ObjectTracker.positionValue = function (parameter, key) {
    var atKey = $._ObjectTracker.call(parameter, "getValueAtKey", [key]);
    if (atKey.available && !atKey.error) return atKey.value;
    var atTime = $._ObjectTracker.call(parameter, "getValueAtTime", [key]);
    if (atTime.available && !atTime.error) return atTime.value;
    return null;
};

$._ObjectTracker.removeCreatedKeys = function (parameter, keys) {
    var removed = 0;
    for (var i = keys.length - 1; i >= 0; i--) {
        try { parameter.removeKey(keys[i]); removed++; } catch (removeError) {}
    }
    return removed;
};

$._ObjectTracker.removeNewKeysSince = function (parameter, beforeKeys) {
    var current = $._ObjectTracker.keyList(parameter);
    if (!current.available) return { removed: 0, verified: false };
    var removed = 0;
    for (var i = current.keys.length - 1; i >= 0; i--) {
        var seconds = $._ObjectTracker.keySeconds(current.keys[i]);
        if (seconds === null || $._ObjectTracker.findExactKey(beforeKeys, seconds, 0.000001)) continue;
        try { parameter.removeKey(current.keys[i]); removed++; } catch (removeError) {}
    }
    return { removed: removed, verified: true };
};

$._ObjectTracker.restoreStaticPosition = function (parameter, beforeVarying, baseline) {
    if (beforeVarying !== false) return false;
    try {
        parameter.setTimeVarying(false);
        parameter.setValue([Number(baseline[0]), Number(baseline[1])], true);
        return true;
    } catch (restoreError) { return false; }
};

$._ObjectTracker.restoreStaticScalar = function (parameter, beforeVarying, baseline) {
    if (beforeVarying !== false) return false;
    try { parameter.setTimeVarying(false); parameter.setValue(Number(baseline), true); return true; }
    catch (restoreError) { return false; }
};

$._ObjectTracker.applyTrackToSelectedTarget = function (trackJson, optionsJson) {
    var track, options;
    try { track = JSON.parse(trackJson); } catch (parseTrackError) { return JSON.stringify({ success: false, stage: "transform-write", code: "INVALID_TRACK_JSON", message: "The cached track data could not be read." }); }
    try { options = JSON.parse(optionsJson || "{}"); } catch (parseOptionsError) { options = {}; }
    var summary = $._ObjectTracker.getSelectedVideoClip();
    var sequence = summary.sequence;
    if (!sequence) return JSON.stringify({ success: false, stage: "transform-write", code: "NO_ACTIVE_SEQUENCE", message: "Open the sequence containing the motion target." });
    if (summary.videos.length !== 1) return JSON.stringify({ success: false, stage: "transform-write", code: summary.videos.length ? "SELECT_ONE_VIDEO_TARGET" : "NO_SELECTED_VIDEO_TARGET", message: "Select exactly one video or graphic timeline clip as the motion target. Linked audio may remain selected.", selectedVideoCount: summary.videos.length });
    if (!track || !track.samples || track.samples.length < 2 || !track.source) return JSON.stringify({ success: false, stage: "transform-write", code: "TRACK_NOT_READY", message: "Read a valid tracked mask before applying motion." });
    var mode = String(options.mode || "follow").toLowerCase();
    var autoScale = mode !== "stabilize" && options.autoScale === true;
    options.autoScale = autoScale;
    var writeScale = autoScale;
    if (writeScale && (!$._ObjectTracker.MotionSolver || !$._ObjectTracker.MotionSolver.hasValidatedBounds(track))) return JSON.stringify({ success: false, stage: "transform-write", code: "TRACK_BOUNDS_UNAVAILABLE", message: "Auto Scale needs decoded and validated per-frame mask bounds." });
    var activeSequenceId = String($._ObjectTracker.read(sequence, "sequenceID") || "");
    if (track.source.sequenceId && String(track.source.sequenceId) !== activeSequenceId) return JSON.stringify({ success: false, stage: "transform-write", code: "SOURCE_TARGET_SEQUENCE_MISMATCH", message: "The selected target is not in the sequence where this track was read. Read the source track again in the target sequence.", sourceSequenceId: track.source.sequenceId, targetSequenceId: activeSequenceId });
    var activeProjectPath = "";
    try { activeProjectPath = String(app.project.path || ""); } catch (projectPathError) {}
    function normalizedPath(value) { return String(value || "").replace(/\\/g, "/").toLowerCase(); }
    if (track.source.projectPath && normalizedPath(track.source.projectPath) !== normalizedPath(activeProjectPath)) return JSON.stringify({ success: false, stage: "transform-write", code: "SOURCE_TARGET_PROJECT_MISMATCH", message: "The open project differs from the project used to read this track. Read the source track again before applying it." });

    var selected = summary.videos[0];
    var clip = selected.clip;
    var selectedNodeId = String($._ObjectTracker.read(clip, "nodeId") || "");
    var sourceNodeId = String(track.source.sourceNodeId || "");
    if (mode === "follow" && sourceNodeId && selectedNodeId === sourceNodeId) {
        return JSON.stringify({ success: false, stage: "transform-write", code: "FOLLOW_TARGET_IS_TRACK_SOURCE", message: "Select a different video or graphic clip to receive Follow motion. The clip with the Object Mask is the track source." });
    }
    var transforms = [];
    var motionComponents = [];
    var positionComponent = null;
    var transformAdded = false;
    if (mode === "stabilize") {
        motionComponents = $._ObjectTracker.findMotionComponents(clip);
        if (motionComponents.length !== 1) return JSON.stringify({ success: false, stage: "transform-write", code: motionComponents.length ? "MULTIPLE_MOTION_COMPONENTS" : "MOTION_COMPONENT_NOT_FOUND", message: motionComponents.length ? "More than one built-in Motion component exists on the selected clip; no keys were written." : "Premiere did not expose the clip's built-in Motion component; no keys were written.", motionCount: motionComponents.length });
        positionComponent = motionComponents[0];
    } else {
        transforms = $._ObjectTracker.findTransformComponents(clip);
        if (transforms.length > 1) return JSON.stringify({ success: false, stage: "transform-write", code: "MULTIPLE_TRANSFORM_COMPONENTS", message: "More than one Transform component exists on the selected clip. Remove the ambiguity before applying track data.", transformCount: transforms.length });
        if (!transforms.length) {
            var added = $._ObjectTracker.addTransformWithQE(clip, selected.trackIndex);
            if (!added.success) return JSON.stringify({ success: false, stage: "transform-write", code: added.code, message: added.message, details: added.details || null });
            transformAdded = true;
            transforms = $._ObjectTracker.findTransformComponents(clip);
            if (transforms.length !== 1) return JSON.stringify({ success: false, stage: "transform-write", code: "TRANSFORM_ADD_NOT_VERIFIED", message: "Transform was added, but its public component identity could not be verified.", transformAdded: true });
        }
        positionComponent = transforms[0];
    }

    var positionLabel = mode === "stabilize" ? "Motion Position" : "Transform Position";
    var positionMatches = $._ObjectTracker.findPositionProperty(positionComponent.component);
    if (positionMatches.length !== 1) return JSON.stringify({ success: false, stage: "transform-write", code: "POSITION_PROPERTY_AMBIGUOUS", message: "Could not uniquely identify " + positionLabel + " by property name.", positionCount: positionMatches.length, transformAdded: transformAdded });
    var position = positionMatches[0];
    var supportsKeys = $._ObjectTracker.call(position, "areKeyframesSupported", []);
    if (!supportsKeys.available || supportsKeys.error || supportsKeys.value !== true) return JSON.stringify({ success: false, stage: "transform-write", code: "POSITION_NOT_KEYFRAMEABLE", message: "Premiere did not confirm that this " + positionLabel + " property supports keyframes.", transformAdded: transformAdded });
    var beforeKeys = $._ObjectTracker.keyList(position);
    if (!beforeKeys.available) return JSON.stringify({ success: false, stage: "transform-write", code: "POSITION_KEYS_UNREADABLE", message: "Could not inspect existing " + positionLabel + " keyframes safely; no keys were written.", details: beforeKeys.error, transformAdded: transformAdded });
    var beforeVarying = $._ObjectTracker.getTimeVarying(position);
    if (beforeVarying === null) return JSON.stringify({ success: false, stage: "transform-write", code: "POSITION_TIMEVARIATION_UNREADABLE", message: "Could not determine whether Transform Position is animated; no keys were written.", transformAdded: transformAdded });
    if (beforeVarying === true || beforeKeys.keys.length) return JSON.stringify({ success: false, stage: "transform-write", code: "POSITION_ALREADY_KEYFRAMED", message: positionLabel + " already has keyframes. Existing animation was preserved; clear only Object Tracker's recorded keys before retrying.", existingKeyCount: beforeKeys.keys.length, timeVarying: beforeVarying, transformAdded: transformAdded });

    var valueResult = $._ObjectTracker.call(position, "getValue", []);
    var baseline = valueResult.available && !valueResult.error ? valueResult.value : null;
    if (!baseline || typeof baseline.length !== "number" || baseline.length < 2 || !isFinite(Number(baseline[0])) || !isFinite(Number(baseline[1]))) return JSON.stringify({ success: false, stage: "transform-write", code: "POSITION_BASELINE_UNREADABLE", message: "Could not read " + positionLabel + " as a two-number array; no animation was written.", transformAdded: transformAdded });

    var settings = null;
    try { settings = sequence.getSettings(); } catch (settingsError) {}
    var sequenceWidth = Number($._ObjectTracker.read(sequence, "frameSizeHorizontal") || (settings && settings.videoFrameWidth));
    var sequenceHeight = Number($._ObjectTracker.read(sequence, "frameSizeVertical") || (settings && settings.videoFrameHeight));
    if (!isFinite(sequenceWidth) || sequenceWidth <= 0 || !isFinite(sequenceHeight) || sequenceHeight <= 0) return JSON.stringify({ success: false, stage: "transform-write", code: "SEQUENCE_DIMENSIONS_UNAVAILABLE", message: "Could not read the sequence frame size for Position conversion.", transformAdded: transformAdded });

    var baselineX = Number(baseline[0]), baselineY = Number(baseline[1]);
    var normalizedPosition = Math.abs(baselineX) <= 4 && Math.abs(baselineY) <= 4;
    var targetStart = Number($._ObjectTracker.read($._ObjectTracker.read(clip, "start"), "seconds"));
    var targetEnd = Number($._ObjectTracker.read($._ObjectTracker.read(clip, "end"), "seconds"));
    var targetIn = Number($._ObjectTracker.read($._ObjectTracker.read(clip, "inPoint"), "seconds"));
    var targetOut = Number($._ObjectTracker.read($._ObjectTracker.read(clip, "outPoint"), "seconds"));
    if (!$._ObjectTracker.allFiniteNumbers([targetStart, targetEnd, targetIn, targetOut]) || targetEnd <= targetStart || targetOut <= targetIn) return JSON.stringify({ success: false, stage: "transform-write", code: "TARGET_TIMING_UNAVAILABLE", message: "Premiere did not return complete target clip timing; no keys were written.", transformAdded: transformAdded });

    var targetRate = (targetEnd - targetStart) / (targetOut - targetIn);
    var sourceWidth = Number(track.source.sourceWidth) || sequenceWidth;
    var sourceHeight = Number(track.source.sourceHeight) || sequenceHeight;
    var deltaXFactor = sourceWidth / sequenceWidth;
    var deltaYFactor = sourceHeight / sequenceHeight;
    var overlap = [];
    for (var sampleIndex = 0; sampleIndex < track.samples.length; sampleIndex++) {
        var sample = track.samples[sampleIndex];
        if (typeof sample.sequenceTime !== "number" || !isFinite(sample.sequenceTime)) continue;
        if (sample.sequenceTime >= targetStart - 0.00001 && sample.sequenceTime <= targetEnd + 0.00001) overlap.push(sample);
    }
    if (overlap.length < 2) return JSON.stringify({ success: false, stage: "transform-write", code: "NO_TRACK_TARGET_OVERLAP", message: "The cached source motion does not overlap this target clip in sequence time. Align the target clip under the source track and retry.", targetStart: targetStart, targetEnd: targetEnd, trackStart: track.samples[0].sequenceTime, trackEnd: track.samples[track.samples.length - 1].sequenceTime, transformAdded: transformAdded });

    if (!$._ObjectTracker.MotionSolver || typeof $._ObjectTracker.MotionSolver.solve !== "function") return JSON.stringify({ success: false, stage: "transform-write", code: "MOTION_SOLVER_UNAVAILABLE", message: "The tracking motion solver did not load; no keys were written.", transformAdded: transformAdded });
    var solved = $._ObjectTracker.MotionSolver.solve({
        track: track,
        overlap: overlap,
        options: options,
        sourceWidth: sourceWidth,
        sourceHeight: sourceHeight,
        sequenceWidth: sequenceWidth,
        sequenceHeight: sequenceHeight,
        targetStart: targetStart,
        targetEnd: targetEnd,
        targetIn: targetIn,
        targetRate: targetRate,
        baselineX: baselineX,
        baselineY: baselineY,
        normalizedPosition: normalizedPosition
    });
    if (!solved.success) return JSON.stringify({ success: false, stage: "transform-write", code: solved.code, message: solved.message, details: solved, transformAdded: transformAdded });
    var planned = solved.positions;

    // Preflight Scale only when the extractor provides validated per-frame bounds.
    var scaleChannels = [];
    var scalePlanned = [];
    if (writeScale) {
        var scaleProperties = $._ObjectTracker.findScaleProperties(positionComponent.component);
        if (scaleProperties.width.length === 1 && scaleProperties.height.length === 1 && !scaleProperties.uniform.length) {
            scaleChannels = [{ name: "width", parameter: scaleProperties.width[0] }, { name: "height", parameter: scaleProperties.height[0] }];
        } else if (scaleProperties.uniform.length === 1 && !scaleProperties.width.length && !scaleProperties.height.length) {
            scaleChannels = [{ name: "uniform", parameter: scaleProperties.uniform[0] }];
        } else {
            return JSON.stringify({ success: false, stage: "transform-write", code: "SCALE_PROPERTIES_AMBIGUOUS", message: "Could not uniquely identify the Transform Scale properties needed for tracking.", scalePropertyCounts: { width: scaleProperties.width.length, height: scaleProperties.height.length, uniform: scaleProperties.uniform.length }, transformAdded: transformAdded });
        }
        var scaleBaselines = [];
        for (var sc = 0; sc < scaleChannels.length; sc++) {
            var scaleParameter = scaleChannels[sc].parameter;
            var scaleSupported = $._ObjectTracker.call(scaleParameter, "areKeyframesSupported", []);
            var scaleBeforeKeys = $._ObjectTracker.keyList(scaleParameter);
            var scaleBeforeVarying = $._ObjectTracker.getTimeVarying(scaleParameter);
            var scaleValue = $._ObjectTracker.call(scaleParameter, "getValue", []);
            if (!scaleSupported.available || scaleSupported.error || scaleSupported.value !== true || !scaleBeforeKeys.available || scaleBeforeVarying === null || scaleBeforeVarying === true || scaleBeforeKeys.keys.length) {
                return JSON.stringify({ success: false, stage: "transform-write", code: "SCALE_ALREADY_KEYFRAMED_OR_UNAVAILABLE", message: "Tracking needs readable, unanimated Transform Scale properties. Existing Scale animation was preserved; clear only Object Tracker's recorded keys or choose another target.", channel: scaleChannels[sc].name, existingKeyCount: scaleBeforeKeys.keys ? scaleBeforeKeys.keys.length : null, transformAdded: transformAdded });
            }
            var baseScale = scaleValue.available && !scaleValue.error ? Number(scaleValue.value) : NaN;
            if (!isFinite(baseScale) || baseScale <= 0) return JSON.stringify({ success: false, stage: "transform-write", code: "SCALE_BASELINE_UNREADABLE", message: "Could not read a positive numeric Transform Scale baseline; no keys were written.", channel: scaleChannels[sc].name, transformAdded: transformAdded });
            scaleBaselines.push({ value: baseScale, timeVarying: scaleBeforeVarying, keys: scaleBeforeKeys.keys });
        }
        var relativeScales = solved.scaleFactors;
        if (!relativeScales || relativeScales.length !== overlap.length) return JSON.stringify({ success: false, stage: "transform-write", code: "TRACK_SCALE_UNAVAILABLE", message: "The motion solver did not return one validated mask-size ratio per frame; no keys were written.", transformAdded: transformAdded });
        for (var sc2 = 0; sc2 < scaleChannels.length; sc2++) {
            scaleChannels[sc2].baseline = scaleBaselines[sc2];
            var scaleMethods = scaleChannels[sc2].parameter;
            if (typeof $._ObjectTracker.read(scaleMethods, "setTimeVarying") !== "function" || typeof $._ObjectTracker.read(scaleMethods, "addKey") !== "function" || typeof $._ObjectTracker.read(scaleMethods, "setValueAtKey") !== "function" || typeof $._ObjectTracker.read(scaleMethods, "removeKey") !== "function") return JSON.stringify({ success: false, stage: "transform-write", code: "SCALE_WRITE_API_INCOMPLETE", message: "Premiere's Transform Scale keyframe writer or rollback methods are unavailable; no keys were written.", channel: scaleChannels[sc2].name, transformAdded: transformAdded });
            for (var scaleSampleIndex = 0; scaleSampleIndex < planned.length; scaleSampleIndex++) {
                var factor = relativeScales[scaleSampleIndex].factor;
                scalePlanned.push({ channel: sc2, seconds: planned[scaleSampleIndex].seconds, value: scaleBaselines[sc2].value * factor });
            }
        }
    }

    var methods = {
        setTimeVarying: typeof $._ObjectTracker.read(position, "setTimeVarying") === "function",
        addKey: typeof $._ObjectTracker.read(position, "addKey") === "function",
        setValueAtKey: typeof $._ObjectTracker.read(position, "setValueAtKey") === "function",
        removeKey: typeof $._ObjectTracker.read(position, "removeKey") === "function"
    };
    if (!methods.setTimeVarying || !methods.addKey || !methods.setValueAtKey || !methods.removeKey) return JSON.stringify({ success: false, stage: "transform-write", code: "POSITION_WRITE_API_INCOMPLETE", message: "Premiere's keyframe writer or rollback methods are unavailable; no keys were written.", methods: methods, transformAdded: transformAdded });

    var desiredTimes = [];
    for (var d = 0; d < planned.length; d++) desiredTimes.push(planned[d].seconds);
    var createdKeys = [];
    var failure = null;
    try {
        position.setTimeVarying(true);
        for (var k = 0; k < planned.length; k++) {
            var time = new Time();
            time.seconds = planned[k].seconds;
            position.addKey(time);
            createdKeys.push(time);
            position.setValueAtKey(time, planned[k].value, false);
        }
        // Premiere may create a default key at the current playhead when time
        // variation is enabled. Remove it only if it was absent before and is
        // not one of the generated timestamps.
        var afterAdd = $._ObjectTracker.keyList(position);
        if (afterAdd.available) {
            for (var a = afterAdd.keys.length - 1; a >= 0; a--) {
                var actualSeconds = $._ObjectTracker.keySeconds(afterAdd.keys[a]);
                if (actualSeconds === null) continue;
                var wanted = false;
                for (var w = 0; w < desiredTimes.length; w++) if (Math.abs(desiredTimes[w] - actualSeconds) <= 0.000001) wanted = true;
                if (!wanted) {
                    var existed = $._ObjectTracker.findExactKey(beforeKeys.keys, actualSeconds, 0.000001);
                    if (!existed) { try { position.removeKey(afterAdd.keys[a]); } catch (cleanupError) {} }
                }
            }
        }
    } catch (writeError) {
        failure = String(writeError);
    }

    if (failure) {
        var rollback = $._ObjectTracker.removeNewKeysSince(position, beforeKeys.keys);
        var restored = $._ObjectTracker.restoreStaticPosition(position, beforeVarying, [baselineX, baselineY]);
        return JSON.stringify({ success: false, stage: "transform-write", code: "POSITION_WRITE_FAILED", message: "Premiere rejected a generated Position key; new keys were rolled back where possible.", details: failure, rolledBackKeyCount: rollback.removed, rollbackVerified: rollback.verified, staticValueRestored: restored, transformAdded: transformAdded });
    }

    var verify = $._ObjectTracker.keyList(position);
    if (!verify.available) {
        var verifyRollback = $._ObjectTracker.removeNewKeysSince(position, beforeKeys.keys);
        var verifyRestored = $._ObjectTracker.restoreStaticPosition(position, beforeVarying, [baselineX, baselineY]);
        return JSON.stringify({ success: false, stage: "transform-write", code: "POSITION_WRITE_UNVERIFIED", message: "Keys were submitted, but Premiere did not return a readable key list. Newly submitted keys were removed where possible.", rolledBackKeyCount: verifyRollback.removed, rollbackVerified: verifyRollback.verified, staticValueRestored: verifyRestored, transformAdded: transformAdded });
    }

    var generated = [];
    for (var q = 0; q < planned.length; q++) {
        var key = $._ObjectTracker.findExactKey(verify.keys, planned[q].seconds, 0.00001);
        var value = key ? $._ObjectTracker.positionValue(position, key) : null;
        if (!key || !value || typeof value.length !== "number" || Math.abs(Number(value[0]) - planned[q].value[0]) > 0.0001 || Math.abs(Number(value[1]) - planned[q].value[1]) > 0.0001) {
            failure = "Premiere could not read back every generated key at the submitted time and value.";
            break;
        }
        generated.push({ time: planned[q].seconds, value: [planned[q].value[0], planned[q].value[1]] });
    }
    if (failure) {
        var readbackRollback = $._ObjectTracker.removeNewKeysSince(position, beforeKeys.keys);
        var readbackRestored = $._ObjectTracker.restoreStaticPosition(position, beforeVarying, [baselineX, baselineY]);
        return JSON.stringify({ success: false, stage: "transform-write", code: "POSITION_READBACK_FAILED", message: failure, rolledBackKeyCount: readbackRollback.removed, rollbackVerified: readbackRollback.verified, staticValueRestored: readbackRestored, transformAdded: transformAdded });
    }

    var generatedScale = [];
    if (writeScale) {
        try {
            for (var sch = 0; sch < scaleChannels.length; sch++) scaleChannels[sch].parameter.setTimeVarying(true);
            for (var sk = 0; sk < scalePlanned.length; sk++) {
                var scaleKey = new Time();
                scaleKey.seconds = scalePlanned[sk].seconds;
                var channel = scaleChannels[scalePlanned[sk].channel];
                channel.parameter.addKey(scaleKey);
                channel.parameter.setValueAtKey(scaleKey, scalePlanned[sk].value, false);
            }
        } catch (scaleWriteError) { failure = String(scaleWriteError); }
        if (!failure) {
            for (var sv = 0; sv < scaleChannels.length; sv++) {
                var scaleVerify = $._ObjectTracker.keyList(scaleChannels[sv].parameter);
                if (!scaleVerify.available) { failure = "Premiere did not return a readable key list for Transform Scale."; break; }
                for (var skv = 0; skv < overlap.length; skv++) {
                    var expected = scalePlanned[sv * overlap.length + skv];
                    var scaleKeyAtTime = $._ObjectTracker.findExactKey(scaleVerify.keys, expected.seconds, 0.00001);
                    var scaleReadback = scaleKeyAtTime ? $._ObjectTracker.positionValue(scaleChannels[sv].parameter, scaleKeyAtTime) : null;
                    if (scaleReadback === null || !isFinite(Number(scaleReadback)) || Math.abs(Number(scaleReadback) - expected.value) > 0.001) {
                        failure = "Premiere could not read back every generated Transform Scale key.";
                        break;
                    }
                    generatedScale.push({ channel: scaleChannels[sv].name, time: expected.seconds, value: expected.value });
                }
                if (failure) break;
            }
        }
        if (failure) {
            for (var sr = 0; sr < scaleChannels.length; sr++) {
                var scaleRollback = $._ObjectTracker.removeNewKeysSince(scaleChannels[sr].parameter, scaleChannels[sr].baseline.keys);
                $._ObjectTracker.restoreStaticScalar(scaleChannels[sr].parameter, scaleChannels[sr].baseline.timeVarying, scaleChannels[sr].baseline.value);
            }
            var positionRollback = $._ObjectTracker.removeNewKeysSince(position, beforeKeys.keys);
            var positionRestored = $._ObjectTracker.restoreStaticPosition(position, beforeVarying, [baselineX, baselineY]);
            return JSON.stringify({ success: false, stage: "transform-write", code: "SCALE_WRITE_FAILED", message: "Premiere rejected or could not verify the generated Scale keys. New Position and Scale keys were rolled back where possible.", details: failure, positionRollbackVerified: positionRollback.verified, positionStaticValueRestored: positionRestored, transformAdded: transformAdded });
        }
    }

    var scaleBaselineReport = [];
    if (writeScale) {
        for (var scaleReportIndex = 0; scaleReportIndex < scaleChannels.length; scaleReportIndex++) {
            var reportedChannel = scaleChannels[scaleReportIndex];
            scaleBaselineReport.push({ name: reportedChannel.name, value: reportedChannel.baseline.value, initialTimeVarying: reportedChannel.baseline.timeVarying, initialKeyCount: reportedChannel.baseline.keys.length });
        }
    }
    return JSON.stringify({
        success: true,
        stage: "transform-write",
        code: "TRACK_APPLIED",
        message: mode === "stabilize"
            ? "Verified editable Motion Position keyframes for stabilization. No Transform or Scale keys were added."
            : (writeScale ? "Verified editable Transform Position and Scale keyframes on the selected target." : "Verified editable Transform Position keyframes on the selected target."),
        sourceClip: track.source.sourceClipName || null,
        targetClip: String($._ObjectTracker.read(clip, "name") || ""),
        targetNodeId: String($._ObjectTracker.read(clip, "nodeId") || ""),
        targetTrackIndex: selected.trackIndex,
        targetClipIndex: selected.clipIndex,
        sequenceId: String($._ObjectTracker.read(sequence, "sequenceID") || ""),
        mode: mode,
        autoScale: autoScale,
        scaleFactors: { x: deltaXFactor, y: deltaYFactor },
        axis: { x: options.x !== false, y: options.y !== false },
        positionComponentType: mode === "stabilize" ? "motion" : "transform",
        positionComponent: { matchName: positionComponent.matchName, displayName: positionComponent.displayName, added: transformAdded },
        transform: mode === "stabilize" ? null : { matchName: positionComponent.matchName, displayName: positionComponent.displayName, added: transformAdded },
        positionPropertyLabel: positionLabel,
        coordinateType: normalizedPosition ? "normalized" : "pixels",
        baseline: [baselineX, baselineY],
        initialTimeVarying: beforeVarying,
        initialKeyCount: beforeKeys.keys.length,
        keyCount: generated.length,
        firstKey: generated[0],
        lastKey: generated[generated.length - 1],
        generatedKeys: generated,
        generatedScaleKeys: generatedScale,
        scaleBaseline: scaleBaselineReport,
        sampleCount: track.samples.length,
        trackSource: track.source.source,
        sourceDimensionsAssumedFromSequence: track.source.sourceDimensionsAssumedFromSequence === true,
        motionDiagnostics: solved.diagnostics,
        note: mode === "stabilize"
            ? "Stabilization writes only inverse-motion keys to the clip's built-in Motion Position. The Object Mask and all Scale properties are left untouched."
            : (autoScale ? "Transform Position follows the tracked point independently from Transform Scale, which follows validated mask bounds. The target's existing Transform Scale remains the reference size." : "Transform Position follows the tracked point. The target's existing Transform Position remains the reference placement.")
    });
};

// Convert unexpected ExtendScript exceptions into useful structured diagnostics
// instead of CEP's opaque "EvalScript error." response.
var _applyTrackToSelectedTarget = $._ObjectTracker.applyTrackToSelectedTarget;
$._ObjectTracker.applyTrackToSelectedTarget = function (trackJson, optionsJson) {
    try {
        var result = _applyTrackToSelectedTarget(trackJson, optionsJson);
        if (typeof result === "string" && result.length) return result;
        return JSON.stringify({ success: false, stage: "transform-write", code: "HOST_EMPTY_RESULT", message: "Premiere completed the Apply call without returning a result." });
    } catch (error) {
        var details = String(error);
        try { if (error.line !== undefined) details += " (line " + error.line + ")"; } catch (lineError) {}
        try { if (error.fileName) details += " in " + String(error.fileName); } catch (fileError) {}
        return JSON.stringify({ success: false, stage: "transform-write", code: "HOST_EXCEPTION", message: "Premiere hit an unexpected scripting error while applying the track. Check the selected clip's Position keys before retrying.", details: details, possiblePartialWrite: true });
    }
};

$._ObjectTracker.clearGeneratedPositionKeys = function (recordJson) {
    var record;
    try { record = JSON.parse(recordJson); } catch (parseError) { return JSON.stringify({ success: false, stage: "clear-generated-keys", code: "INVALID_CLEAR_RECORD", message: "The saved generated-key record is not valid." }); }
    var summary = $._ObjectTracker.getSelectedVideoClip();
    if (!summary.sequence || summary.videos.length !== 1) return JSON.stringify({ success: false, stage: "clear-generated-keys", code: "SELECT_RECORDED_TARGET", message: "Select the same target clip that received Object Tracker's keys." });
    var selected = summary.videos[0];
    var clip = selected.clip;
    var nodeId = String($._ObjectTracker.read(clip, "nodeId") || "");
    var sequenceId = String($._ObjectTracker.read(summary.sequence, "sequenceID") || "");
    if (nodeId !== String(record.targetNodeId || "") || sequenceId !== String(record.sequenceId || "")) return JSON.stringify({ success: false, stage: "clear-generated-keys", code: "WRONG_TARGET_SELECTED", message: "The selected clip does not match the clip recorded when Object Tracker wrote the keys.", selectedNodeId: nodeId, recordedNodeId: record.targetNodeId, selectedSequenceId: sequenceId, recordedSequenceId: record.sequenceId });
    var component = null;
    if (record.positionComponentType === "motion" || record.positionComponentMatchName === "AE.ADBE Motion") {
        var motionComponents = $._ObjectTracker.findMotionComponents(clip);
        var recordedMotionName = String(record.positionComponentMatchName || "");
        for (var i = 0; i < motionComponents.length; i++) {
            if (recordedMotionName ? motionComponents[i].matchName === recordedMotionName : motionComponents.length === 1) component = motionComponents[i].component;
        }
        if (!component) return JSON.stringify({ success: false, stage: "clear-generated-keys", code: "RECORDED_MOTION_NOT_FOUND", message: "The built-in Motion component recorded for these Position keys was not found." });
    } else {
        var transforms = $._ObjectTracker.findTransformComponents(clip);
        var recordedMatchName = record.positionComponentMatchName || record.transformMatchName;
        for (var t = 0; t < transforms.length; t++) if (transforms[t].matchName === recordedMatchName) component = transforms[t].component;
        if (!component) return JSON.stringify({ success: false, stage: "clear-generated-keys", code: "RECORDED_TRANSFORM_NOT_FOUND", message: "The Transform component recorded for this key set was not found." });
    }
    var positions = $._ObjectTracker.findPositionProperty(component);
    if (positions.length !== 1) return JSON.stringify({ success: false, stage: "clear-generated-keys", code: "POSITION_PROPERTY_AMBIGUOUS", message: "Could not uniquely identify the recorded Position property." });
    var parameter = positions[0];
    var current = $._ObjectTracker.keyList(parameter);
    if (!current.available) return JSON.stringify({ success: false, stage: "clear-generated-keys", code: "POSITION_KEYS_UNREADABLE", message: "Could not inspect Position keyframes; none were removed.", details: current.error });
    var removed = 0, changed = 0, missing = 0;
    var records = record.generatedKeys || [];
    for (var k = records.length - 1; k >= 0; k--) {
        var key = $._ObjectTracker.findExactKey(current.keys, Number(records[k].time), 0.00001);
        if (!key) { missing++; continue; }
        var value = $._ObjectTracker.positionValue(parameter, key);
        if (!value || Math.abs(Number(value[0]) - Number(records[k].value[0])) > 0.0001 || Math.abs(Number(value[1]) - Number(records[k].value[1])) > 0.0001) { changed++; continue; }
        try { parameter.removeKey(key); removed++; } catch (removeError) { changed++; }
    }
    var resetToStatic = false;
    var remaining = $._ObjectTracker.keyList(parameter);
    if (record.initialTimeVarying === false && remaining.available && remaining.keys.length === 0) {
        resetToStatic = $._ObjectTracker.restoreStaticPosition(parameter, false, record.baseline || [0.5, 0.5]);
    }
    var scaleRemoved = 0, scaleChanged = 0, scaleMissing = 0;
    var scaleRecords = record.generatedScaleKeys || [];
    if (scaleRecords.length) {
        var scales = $._ObjectTracker.findScaleProperties(component);
        for (var scaleRecordIndex = scaleRecords.length - 1; scaleRecordIndex >= 0; scaleRecordIndex--) {
            var scaleRecord = scaleRecords[scaleRecordIndex];
            var matches = scales[scaleRecord.channel] || [];
            if (matches.length !== 1) { scaleChanged++; continue; }
            var scaleParameter = matches[0];
            var scaleKeysNow = $._ObjectTracker.keyList(scaleParameter);
            if (!scaleKeysNow.available) { scaleChanged++; continue; }
            var recordedScaleKey = $._ObjectTracker.findExactKey(scaleKeysNow.keys, Number(scaleRecord.time), 0.00001);
            if (!recordedScaleKey) { scaleMissing++; continue; }
            var recordedScaleValue = $._ObjectTracker.positionValue(scaleParameter, recordedScaleKey);
            if (recordedScaleValue === null || Math.abs(Number(recordedScaleValue) - Number(scaleRecord.value)) > 0.001) { scaleChanged++; continue; }
            try { scaleParameter.removeKey(recordedScaleKey); scaleRemoved++; } catch (scaleRemoveError) { scaleChanged++; }
        }
        var baselines = record.scaleBaseline || [];
        for (var baselineIndex = 0; baselineIndex < baselines.length; baselineIndex++) {
            var baselineRecord = baselines[baselineIndex];
            var baselineMatches = scales[baselineRecord.name] || [];
            if (baselineMatches.length !== 1) continue;
            var remainingScale = $._ObjectTracker.keyList(baselineMatches[0]);
            if (baselineRecord.initialTimeVarying === false && remainingScale.available && remainingScale.keys.length === 0) {
                $._ObjectTracker.restoreStaticScalar(baselineMatches[0], false, baselineRecord.value);
            }
        }
    }
    return JSON.stringify({ success: true, stage: "clear-generated-keys", code: "GENERATED_KEYS_CLEARED", message: "Removed Object Tracker keys whose timestamps and values still match the saved record; user-edited keys were kept.", removedKeyCount: removed, missingKeyCount: missing, changedKeyCount: changed, scaleRemovedKeyCount: scaleRemoved, scaleMissingKeyCount: scaleMissing, scaleChangedKeyCount: scaleChanged, remainingKeyCount: remaining.available ? remaining.keys.length : null, resetToStatic: resetToStatic, positionComponentType: record.positionComponentType || "transform", transformKept: true });
};
