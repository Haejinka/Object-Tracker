$._ObjectTracker.savedProjectContext = function () {
    var project = app.project;
    var sequence = $._ObjectTracker.getActiveSequence();
    if (!project) {
        return JSON.stringify({
            success: false,
            stage: "saved-project-context",
            code: "NO_PROJECT",
            message: "No Premiere project is open."
        });
    }

    var projectPath = "";
    var dirty = null;
    try { projectPath = String(project.path || ""); } catch (pathError) {}
    try { dirty = project.dirty === true; } catch (dirtyError) {}

    var selected = $._ObjectTracker.getSelectedTrackItems(sequence);
    var selectedVideo = [];
    function ticksOf(time) {
        if (!time) return null;
        var ticks = $._ObjectTracker.read(time, "ticks");
        if (ticks !== undefined && ticks !== null) return String(ticks);
        var seconds = $._ObjectTracker.read(time, "seconds");
        return typeof seconds === "number" ? String(seconds) : null;
    }
    function numberOf(value) {
        return typeof value === "number" && isFinite(value) ? value : null;
    }
    function motionScaleOf(clip) {
        var components = $._ObjectTracker.read(clip, "components");
        var count = components ? $._ObjectTracker.read(components, "numItems") : 0;
        for (var componentIndex = 0; componentIndex < count; componentIndex++) {
            var component = $._ObjectTracker.read(components, componentIndex);
            if (!component) continue;
            var matchName = String($._ObjectTracker.read(component, "matchName") || "");
            var displayName = String($._ObjectTracker.read(component, "displayName") || "");
            if (matchName !== "AE.ADBE Motion" && displayName.toLowerCase() !== "motion") continue;
            var properties = $._ObjectTracker.read(component, "properties");
            var propertyCount = properties ? $._ObjectTracker.read(properties, "numItems") : 0;
            for (var propertyIndex = 0; propertyIndex < propertyCount; propertyIndex++) {
                var parameter = $._ObjectTracker.read(properties, propertyIndex);
                if (!parameter) continue;
                var propertyName = String($._ObjectTracker.read(parameter, "displayName") || "");
                if (propertyName.toLowerCase() !== "scale") continue;
                var result = $._ObjectTracker.call(parameter, "getValue", []);
                if (result.available && result.error === undefined && typeof result.value === "number") return result.value;
            }
        }
        return null;
    }
    var sequenceWidth = sequence ? numberOf($._ObjectTracker.read(sequence, "frameSizeHorizontal")) : null;
    var sequenceHeight = sequence ? numberOf($._ObjectTracker.read(sequence, "frameSizeVertical")) : null;
    var sequenceTimebase = sequence ? ticksOf($._ObjectTracker.read(sequence, "timebase")) : null;
    for (var i = 0; i < selected.items.length; i++) {
        var clip = selected.items[i].clip;
        if (String($._ObjectTracker.read(clip, "mediaType")) === "Video") {
            selectedVideo.push({
                name: $._ObjectTracker.read(clip, "name"),
                nodeId: $._ObjectTracker.read(clip, "nodeId"),
                trackIndex: selected.items[i].trackIndex,
                clipIndex: selected.items[i].clipIndex,
                start: ticksOf($._ObjectTracker.read(clip, "start")),
                end: ticksOf($._ObjectTracker.read(clip, "end")),
                inPoint: ticksOf($._ObjectTracker.read(clip, "inPoint")),
                outPoint: ticksOf($._ObjectTracker.read(clip, "outPoint")),
                duration: ticksOf($._ObjectTracker.read(clip, "duration")),
                motionScale: motionScaleOf(clip),
                sourceWidth: (function () {
                    var item = $._ObjectTracker.read(clip, "projectItem");
                    var width = item ? numberOf($._ObjectTracker.read(item, "frameSizeHorizontal")) : null;
                    if (width === null && item) width = numberOf($._ObjectTracker.read(item, "width"));
                    return width;
                }()),
                sourceHeight: (function () {
                    var item = $._ObjectTracker.read(clip, "projectItem");
                    var height = item ? numberOf($._ObjectTracker.read(item, "frameSizeVertical")) : null;
                    if (height === null && item) height = numberOf($._ObjectTracker.read(item, "height"));
                    return height;
                }())
            });
        }
    }

    var payload = {
        success: true,
        stage: "saved-project-context",
        projectPath: projectPath,
        projectDirty: dirty,
        sequence: sequence ? $._ObjectTracker.read(sequence, "name") : null,
        sequenceId: sequence ? $._ObjectTracker.read(sequence, "sequenceID") : null,
        sequenceFrameWidth: sequenceWidth,
        sequenceFrameHeight: sequenceHeight,
        sequenceTimebaseTicks: sequenceTimebase,
        selectedVideoClips: selectedVideo,
        message: dirty === true
            ? "The project has unsaved changes. Save it manually before scanning the saved project data."
            : "Saved project context is ready for read-only inspection."
    };
    return JSON.stringify(payload);
};
