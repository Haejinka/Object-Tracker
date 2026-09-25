$._ObjectTracker = $._ObjectTracker || {};
$._ObjectTracker.version = "0.1.0";

$._ObjectTracker.safe = function (callback) {
    try {
        return { ok: true, value: callback() };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
};

$._ObjectTracker.read = function (object, key) {
    var result = $._ObjectTracker.safe(function () { return object[key]; });
    return result.ok ? result.value : undefined;
};

$._ObjectTracker.call = function (object, methodName, args) {
    var method = $._ObjectTracker.read(object, methodName);
    if (typeof method !== "function") {
        return { available: false, error: "Method is not exposed." };
    }
    try {
        return { available: true, value: method.apply(object, args || []) };
    } catch (error) {
        return { available: true, error: String(error) };
    }
};

$._ObjectTracker.timeInfo = function (time) {
    if (time === null || time === undefined) return time;
    if (typeof time === "string" || typeof time === "number" || typeof time === "boolean") return time;
    var result = { type: "Time" };
    var ticks = $._ObjectTracker.read(time, "ticks");
    var seconds = $._ObjectTracker.read(time, "seconds");
    if (ticks !== undefined) result.ticks = String(ticks);
    if (seconds !== undefined) result.seconds = seconds;
    return result;
};

$._ObjectTracker.serializeValue = function (value, depth, seen) {
    depth = depth || 0;
    seen = seen || [];

    if (value === undefined) return "undefined";
    if (value === null) return null;

    var kind = typeof value;
    if (kind === "string" || kind === "number" || kind === "boolean") return value;
    if (kind === "function") return "[function]";
    if (depth >= 5) return "[depth limit]";

    for (var seenIndex = 0; seenIndex < seen.length; seenIndex++) {
        if (seen[seenIndex] === value) return "[circular reference]";
    }
    seen.push(value);

    var ticks = $._ObjectTracker.read(value, "ticks");
    var seconds = $._ObjectTracker.read(value, "seconds");
    if (ticks !== undefined && seconds !== undefined) {
        seen.pop();
        return { type: "Time", ticks: String(ticks), seconds: seconds };
    }

    if (value instanceof Array) {
        var arrayValue = [];
        var arrayLimit = Math.min(value.length, 500);
        for (var i = 0; i < arrayLimit; i++) {
            arrayValue.push($._ObjectTracker.serializeValue(value[i], depth + 1, seen));
        }
        if (value.length > arrayLimit) arrayValue.push("[array truncated: " + value.length + " items]");
        seen.pop();
        return arrayValue;
    }

    var objectValue = { type: "object" };
    var count = 0;
    for (var key in value) {
        if (count >= 64) {
            objectValue.__truncated = true;
            break;
        }
        var member = $._ObjectTracker.safe((function (target, memberName) {
            return function () { return target[memberName]; };
        }(value, key)));
        if (member.ok) {
            objectValue[key] = $._ObjectTracker.serializeValue(member.value, depth + 1, seen);
        } else {
            objectValue[key] = "[read error: " + member.error + "]";
        }
        count++;
    }
    if (count === 0) objectValue.text = String(value);
    seen.pop();
    return objectValue;
};

$._ObjectTracker.runtimeMembers = function (object, limit) {
    var members = [];
    limit = limit || 128;
    if (!object) return members;

    for (var key in object) {
        if (members.length >= limit) {
            members.push("[member list truncated]");
            break;
        }
        var member = $._ObjectTracker.safe((function (target, memberName) {
            return function () { return target[memberName]; };
        }(object, key)));
        if (!member.ok) {
            members.push(key + " [read error]");
        } else if (typeof member.value === "function") {
            members.push(key + "()");
        } else {
            members.push(key);
        }
    }
    return members;
};

$._ObjectTracker.getActiveSequence = function () {
    var project = app.project;
    return project ? project.activeSequence : null;
};

$._ObjectTracker.getSelectedTrackItems = function (sequence) {
    var selected = [];
    var errors = [];
    if (!sequence) return { items: selected, errors: ["No active sequence is open."] };

    var trackTypes = ["videoTracks", "audioTracks"];
    for (var typeIndex = 0; typeIndex < trackTypes.length; typeIndex++) {
        var collectionName = trackTypes[typeIndex];
        var tracks = $._ObjectTracker.read(sequence, collectionName);
        var trackCount = tracks ? $._ObjectTracker.read(tracks, "numTracks") : 0;
        if (typeof trackCount !== "number") trackCount = 0;

        for (var trackIndex = 0; trackIndex < trackCount; trackIndex++) {
            var track = $._ObjectTracker.read(tracks, trackIndex);
            var clips = track ? $._ObjectTracker.read(track, "clips") : null;
            var clipCount = clips ? $._ObjectTracker.read(clips, "numItems") : 0;
            if (typeof clipCount !== "number") clipCount = 0;

            for (var clipIndex = 0; clipIndex < clipCount; clipIndex++) {
                var clip = $._ObjectTracker.read(clips, clipIndex);
                if (!clip) continue;
                var isSelected = $._ObjectTracker.call(clip, "isSelected", []);
                if (isSelected.available && isSelected.error === undefined && isSelected.value) {
                    selected.push({
                        clip: clip,
                        trackType: collectionName === "videoTracks" ? "video" : "audio",
                        trackIndex: trackIndex,
                        clipIndex: clipIndex
                    });
                } else if (isSelected.error) {
                    errors.push("Could not read selection state for " + $._ObjectTracker.read(clip, "name") + ": " + isSelected.error);
                }
            }
        }
    }

    return { items: selected, errors: errors };
};
