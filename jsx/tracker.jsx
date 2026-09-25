$._ObjectTracker.inspectTrackCandidatesOnClip = function (clip) {
    var report = {
        sourceClip: {
            name: $._ObjectTracker.read(clip, "name"),
            nodeId: $._ObjectTracker.read(clip, "nodeId"),
            mediaType: $._ObjectTracker.read(clip, "mediaType")
        },
        candidates: []
    };
    var components = $._ObjectTracker.read(clip, "components");
    var componentCount = components ? $._ObjectTracker.read(components, "numItems") : 0;
    var hasMaskComponent = false;
    var hasTemporalCandidate = false;

    for (var componentIndex = 0; componentIndex < componentCount; componentIndex++) {
        var component = $._ObjectTracker.read(components, componentIndex);
        if (!component) continue;

        var name = String($._ObjectTracker.read(component, "displayName") || "");
        var matchName = String($._ObjectTracker.read(component, "matchName") || "");
        var componentText = (name + " " + matchName).toLowerCase();
        var isMaskLike = componentText.indexOf("mask") >= 0 || componentText.indexOf("object") >= 0;
        if (isMaskLike) hasMaskComponent = true;

        var properties = $._ObjectTracker.read(component, "properties");
        var propertyCount = properties ? $._ObjectTracker.read(properties, "numItems") : 0;
        var propertyReports = [];
        var componentHasTemporal = false;

        for (var propertyIndex = 0; propertyIndex < propertyCount; propertyIndex++) {
            var parameter = $._ObjectTracker.read(properties, propertyIndex);
            if (!parameter) continue;
            var stream = $._ObjectTracker.inspectKeyframeStream(parameter);
            var varying = stream.timeVarying === true;
            var keyCount = typeof stream.keyCount === "number" ? stream.keyCount : 0;
            var propertyName = String($._ObjectTracker.read(parameter, "displayName") || "");
            var propertyMatchName = String($._ObjectTracker.read(parameter, "matchName") || "");
            var relevant = isMaskLike || varying || keyCount > 0 || /mask|track|path|vertex|point/i.test(propertyName + " " + propertyMatchName);

            if (varying || keyCount > 0) {
                componentHasTemporal = true;
                hasTemporalCandidate = true;
            }
            if (relevant) {
                var parameterValue = $._ObjectTracker.call(parameter, "getValue", []);
                propertyReports.push({
                    index: propertyIndex,
                    displayName: propertyName,
                    matchName: propertyMatchName,
                    value: parameterValue.available && parameterValue.error === undefined
                        ? $._ObjectTracker.serializeValue(parameterValue.value, 0, [])
                        : (parameterValue.error || "getValue is not exposed"),
                    keyframeStream: stream
                });
            }
        }

        if (isMaskLike || componentHasTemporal) {
            report.candidates.push({
                componentIndex: componentIndex,
                displayName: name,
                matchName: matchName,
                maskLikeName: isMaskLike,
                timeVaryingPropertyFound: componentHasTemporal,
                properties: propertyReports
            });
        }
    }

    report.hasMaskComponent = hasMaskComponent;
    report.hasTemporalCandidate = hasTemporalCandidate;
    return report;
};

$._ObjectTracker.extractTrack = function (clip) {
    if (!clip) {
        return {
            success: false,
            stage: "track-source-detection",
            code: "NO_TRACK_ITEM",
            message: "No source TrackItem was passed to extractTrack()."
        };
    }

    var evidence = $._ObjectTracker.inspectTrackCandidatesOnClip(clip);
    var report = {
        success: false,
        stage: "extract-native-track",
        source: evidence.hasMaskComponent ? "Premiere mask-like component" : "Unclassified temporal component",
        sourceClip: evidence.sourceClip,
        candidates: evidence.candidates,
        normalizedTrack: null
    };

    if (!evidence.candidates.length) {
        report.code = "NO_TRACK_SOURCE_CANDIDATE";
        report.message = "The selected TrackItem exposes no mask-like component or temporal tracking property.";
    } else if (evidence.hasMaskComponent && !evidence.hasTemporalCandidate) {
        report.code = "MASK_WITHOUT_ACCESSIBLE_TEMPORAL_DATA";
        report.message = "Tracking source detected but no accessible temporal properties were found.";
    } else {
        report.code = "TRACK_FORMAT_UNMAPPED";
        report.message = "Candidate properties were found, but Premiere's observed values have not yet been mapped to XY samples.";
    }

    return report;
};

$._ObjectTracker.inspectTrackCandidates = function () {
    var sequence = $._ObjectTracker.getActiveSequence();
    var selection = $._ObjectTracker.getSelectedTrackItems(sequence);
    var report = {
        success: false,
        stage: "track-data-inspection",
        sequence: sequence ? $._ObjectTracker.read(sequence, "name") : null,
        selectedCount: selection.items.length,
        selectedVideoCount: 0
    };

    if (!sequence) {
        report.code = "NO_ACTIVE_SEQUENCE";
        report.message = "No active sequence is available.";
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
        report.message = videoItems.length === 0
            ? "Select the video clip containing the tracked Object Mask. Linked audio may remain selected."
            : "Select one video clip so tracking data can be attributed to a single source.";
        return JSON.stringify(report);
    }

    var extraction = $._ObjectTracker.extractTrack(videoItems[0].clip);
    extraction.stage = "track-data-inspection";
    extraction.sequence = report.sequence;
    extraction.selectedCount = report.selectedCount;
    extraction.selectedVideoCount = report.selectedVideoCount;
    return JSON.stringify(extraction);
};
