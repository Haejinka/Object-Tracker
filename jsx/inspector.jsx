$._ObjectTracker.inspectKeyframeStream = function (parameter) {
    var report = {
        keyframesSupported: null,
        timeVarying: null,
        keyCount: null,
        keys: [],
        methods: {}
    };

    var supported = $._ObjectTracker.call(parameter, "areKeyframesSupported", []);
    report.methods.areKeyframesSupported = supported.available;
    if (supported.available && supported.error === undefined) report.keyframesSupported = supported.value;
    else if (supported.error) report.areKeyframesSupportedError = supported.error;

    var varying = $._ObjectTracker.call(parameter, "isTimeVarying", []);
    report.methods.isTimeVarying = varying.available;
    if (varying.available && varying.error === undefined) report.timeVarying = varying.value;
    else if (varying.error) report.isTimeVaryingError = varying.error;

    var keyList = $._ObjectTracker.call(parameter, "getKeys", []);
    report.methods.getKeys = keyList.available;
    if (keyList.available && keyList.error === undefined) {
        var keys = keyList.value;
        if (keys && typeof keys.length === "number") {
            report.keyCount = keys.length;
            report.keyListState = "array";
            var limit = Math.min(keys.length, 2000);
            for (var keyIndex = 0; keyIndex < limit; keyIndex++) {
                var keyTime = keys[keyIndex];
                var key = { time: $._ObjectTracker.timeInfo(keyTime) };

                var valueAtKey = $._ObjectTracker.call(parameter, "getValueAtKey", [keyTime]);
                key.getValueAtKey = valueAtKey.available && valueAtKey.error === undefined
                    ? $._ObjectTracker.serializeValue(valueAtKey.value, 0, [])
                    : (valueAtKey.error || "not exposed");

                var valueAtTime = $._ObjectTracker.call(parameter, "getValueAtTime", [keyTime]);
                key.getValueAtTime = valueAtTime.available && valueAtTime.error === undefined
                    ? $._ObjectTracker.serializeValue(valueAtTime.value, 0, [])
                    : (valueAtTime.error || "not exposed");

                var interpolation = $._ObjectTracker.call(parameter, "getInterpolationTypeAtKey", [keyTime]);
                if (interpolation.available && interpolation.error === undefined) {
                    key.interpolation = $._ObjectTracker.serializeValue(interpolation.value, 0, []);
                } else if (interpolation.error) {
                    key.interpolationError = interpolation.error;
                }
                report.keys.push(key);
            }
            if (keys.length > limit) report.keysTruncated = true;
        } else if (keys === undefined || keys === null) {
            report.keyCount = 0;
            report.keyListState = "undefined-or-null";
        } else {
            report.keyListState = "non-array";
            report.keyListValue = $._ObjectTracker.serializeValue(keys, 0, []);
        }
    } else if (keyList.error) {
        report.getKeysError = keyList.error;
    }

    report.methods.getValueAtTime = typeof $._ObjectTracker.read(parameter, "getValueAtTime") === "function";
    report.methods.getValueAtKey = typeof $._ObjectTracker.read(parameter, "getValueAtKey") === "function";
    report.methods.keyExistsAtTime = typeof $._ObjectTracker.read(parameter, "keyExistsAtTime") === "function";
    report.methods.findNearestKey = typeof $._ObjectTracker.read(parameter, "findNearestKey") === "function";
    report.methods.findNextKey = typeof $._ObjectTracker.read(parameter, "findNextKey") === "function";
    report.methods.findPreviousKey = typeof $._ObjectTracker.read(parameter, "findPreviousKey") === "function";
    report.methods.addKey = typeof $._ObjectTracker.read(parameter, "addKey") === "function";
    report.methods.setTimeVarying = typeof $._ObjectTracker.read(parameter, "setTimeVarying") === "function";
    report.methods.setValue = typeof $._ObjectTracker.read(parameter, "setValue") === "function";
    report.methods.setValueAtKey = typeof $._ObjectTracker.read(parameter, "setValueAtKey") === "function";
    report.methods.setInterpolationTypeAtKey = typeof $._ObjectTracker.read(parameter, "setInterpolationTypeAtKey") === "function";
    report.methods.removeKeyRange = typeof $._ObjectTracker.read(parameter, "removeKeyRange") === "function";

    return report;
};

$._ObjectTracker.inspectComponent = function (component, componentIndex) {
    var output = {
        index: componentIndex,
        displayName: $._ObjectTracker.read(component, "displayName"),
        matchName: $._ObjectTracker.read(component, "matchName"),
        instanceName: $._ObjectTracker.read(component, "instanceName"),
        runtimeMembers: $._ObjectTracker.runtimeMembers(component),
        propertyCount: 0,
        properties: []
    };

    var properties = $._ObjectTracker.read(component, "properties");
    var propertyCount = properties ? $._ObjectTracker.read(properties, "numItems") : 0;
    if (typeof propertyCount !== "number") propertyCount = 0;
    output.propertyCount = propertyCount;

    for (var propertyIndex = 0; propertyIndex < propertyCount; propertyIndex++) {
        var parameter = $._ObjectTracker.read(properties, propertyIndex);
        if (!parameter) continue;

        var valueResult = $._ObjectTracker.call(parameter, "getValue", []);
        var propertyReport = {
            index: propertyIndex,
            displayName: $._ObjectTracker.read(parameter, "displayName"),
            matchName: $._ObjectTracker.read(parameter, "matchName"),
            runtimeMembers: $._ObjectTracker.runtimeMembers(parameter),
            value: valueResult.available && valueResult.error === undefined
                ? $._ObjectTracker.serializeValue(valueResult.value, 0, [])
                : (valueResult.error || "getValue is not exposed"),
            valueType: valueResult.available && valueResult.error === undefined
                ? typeof valueResult.value
                : "unavailable",
            keyframeStream: $._ObjectTracker.inspectKeyframeStream(parameter)
        };
        if (valueResult.error) propertyReport.getValueError = valueResult.error;
        output.properties.push(propertyReport);
    }

    return output;
};

$._ObjectTracker.inspectTrackItem = function (selection) {
    var clip = selection.clip;
    var output = {
        name: $._ObjectTracker.read(clip, "name"),
        nodeId: $._ObjectTracker.read(clip, "nodeId"),
        matchName: $._ObjectTracker.read(clip, "matchName"),
        mediaType: $._ObjectTracker.read(clip, "mediaType"),
        type: $._ObjectTracker.read(clip, "type"),
        selected: true,
        trackType: selection.trackType,
        trackIndex: selection.trackIndex,
        clipIndex: selection.clipIndex,
        trackIndexFromHost: $._ObjectTracker.read(clip, "parentTrackIndex"),
        start: $._ObjectTracker.timeInfo($._ObjectTracker.read(clip, "start")),
        end: $._ObjectTracker.timeInfo($._ObjectTracker.read(clip, "end")),
        duration: $._ObjectTracker.timeInfo($._ObjectTracker.read(clip, "duration")),
        inPoint: $._ObjectTracker.timeInfo($._ObjectTracker.read(clip, "inPoint")),
        outPoint: $._ObjectTracker.timeInfo($._ObjectTracker.read(clip, "outPoint")),
        runtimeMembers: $._ObjectTracker.runtimeMembers(clip),
        components: []
    };

    var projectItem = $._ObjectTracker.read(clip, "projectItem");
    if (projectItem) {
        output.projectItem = {
            name: $._ObjectTracker.read(projectItem, "name"),
            nodeId: $._ObjectTracker.read(projectItem, "nodeId"),
            type: $._ObjectTracker.read(projectItem, "type"),
            treePath: $._ObjectTracker.read(projectItem, "treePath")
        };
    }

    var components = $._ObjectTracker.read(clip, "components");
    var componentCount = components ? $._ObjectTracker.read(components, "numItems") : 0;
    if (typeof componentCount !== "number") componentCount = 0;
    output.componentCount = componentCount;

    for (var componentIndex = 0; componentIndex < componentCount; componentIndex++) {
        var component = $._ObjectTracker.read(components, componentIndex);
        if (component) output.components.push($._ObjectTracker.inspectComponent(component, componentIndex));
    }

    return output;
};

$._ObjectTracker.inspectSelectedClip = function () {
    var sequence = $._ObjectTracker.getActiveSequence();
    var selection = $._ObjectTracker.getSelectedTrackItems(sequence);
    var report = {
        success: !!sequence,
        stage: "inspect-selected-clip",
        host: { application: "Premiere Pro", version: app.version, extensionVersion: $._ObjectTracker.version },
        sequence: sequence ? {
            name: $._ObjectTracker.read(sequence, "name"),
            sequenceID: $._ObjectTracker.read(sequence, "sequenceID"),
            timebase: $._ObjectTracker.serializeValue($._ObjectTracker.read(sequence, "timebase"), 0, []),
            zeroPoint: $._ObjectTracker.timeInfo($._ObjectTracker.read(sequence, "zeroPoint")),
            frameSizeHorizontal: $._ObjectTracker.read(sequence, "frameSizeHorizontal"),
            frameSizeVertical: $._ObjectTracker.read(sequence, "frameSizeVertical")
        } : null,
        selectedCount: selection.items.length,
        selectionErrors: selection.errors,
        selectedClips: []
    };

    if (!sequence) {
        report.success = false;
        report.code = "NO_ACTIVE_SEQUENCE";
        report.message = "Open a Premiere sequence before inspecting a clip.";
    } else if (selection.items.length === 0) {
        report.success = false;
        report.code = "NO_SELECTED_CLIP";
        report.message = "No selected timeline clip was exposed through TrackItem.isSelected().";
    } else {
        for (var i = 0; i < selection.items.length; i++) {
            report.selectedClips.push($._ObjectTracker.inspectTrackItem(selection.items[i]));
        }
        report.message = "Inspected " + selection.items.length + " selected timeline item(s).";
    }

    return JSON.stringify(report);
};
