(function () {
    $._ObjectTracker = $._ObjectTracker || {};

    $._ObjectTracker.MotionSolver = {
        hasValidatedBounds: function (track) {
            if (!track || !track.capabilities || track.capabilities.bounds !== true || track.capabilities.scale !== true) return false;
            if (!track.samples || track.samples.length < 2) return false;
            for (var i = 0; i < track.samples.length; i++) {
                var sample = track.samples[i];
                if (!isFinite(Number(sample.centerX)) || !isFinite(Number(sample.centerY)) ||
                    !isFinite(Number(sample.width)) || !isFinite(Number(sample.height)) ||
                    Number(sample.width) <= 0 || Number(sample.height) <= 0) return false;
            }
            return true;
        },

        solve: function (input) {
            input = input || {};
            var track = input.track;
            var overlap = input.overlap || [];
            var options = input.options || {};
            var errors = [];
            if (!track || !track.samples || track.samples.length < 2 || overlap.length < 2) {
                return { success: false, code: "MOTION_INPUT_INCOMPLETE", message: "At least two tracked samples overlapping the target are required." };
            }
            if (options.autoScale && !$._ObjectTracker.MotionSolver.hasValidatedBounds(track)) {
                return { success: false, code: "TRACK_BOUNDS_UNAVAILABLE", message: "Auto Scale needs validated per-frame mask bounds." };
            }
            var sourceWidth = Number(input.sourceWidth);
            var sourceHeight = Number(input.sourceHeight);
            var sequenceWidth = Number(input.sequenceWidth);
            var sequenceHeight = Number(input.sequenceHeight);
            if (!isFinite(sourceWidth) || sourceWidth <= 0 || !isFinite(sourceHeight) || sourceHeight <= 0 ||
                !isFinite(sequenceWidth) || sequenceWidth <= 0 || !isFinite(sequenceHeight) || sequenceHeight <= 0) {
                return { success: false, code: "MOTION_DIMENSIONS_UNAVAILABLE", message: "Source and sequence dimensions are required for coordinate conversion." };
            }
            var targetStart = Number(input.targetStart);
            var targetEnd = Number(input.targetEnd);
            var targetIn = Number(input.targetIn);
            var targetRate = Number(input.targetRate);
            var baselineX = Number(input.baselineX);
            var baselineY = Number(input.baselineY);
            // ExtendScript's JavaScript engine can lack ES5 Array.every.
            // Keep this host-side solver compatible with Premiere's JSX runtime.
            var timingValues = [targetStart, targetEnd, targetIn, targetRate, baselineX, baselineY];
            var timingValuesFinite = true;
            for (var timingIndex = 0; timingIndex < timingValues.length; timingIndex++) {
                if (!isFinite(timingValues[timingIndex])) { timingValuesFinite = false; break; }
            }
            if (!timingValuesFinite || targetEnd <= targetStart || targetRate <= 0) {
                return { success: false, code: "MOTION_TIMING_OR_BASELINE_INVALID", message: "Target timing or baseline Position is invalid." };
            }

            var first = overlap[0];
            var firstX = Number(first.x !== undefined ? first.x : first.position && first.position.x);
            var firstY = Number(first.y !== undefined ? first.y : first.position && first.position.y);
            if (!isFinite(firstX) || !isFinite(firstY)) return { success: false, code: "MOTION_POINT_INVALID", message: "The source tracker point is missing or invalid." };
            var normalizedPosition = input.normalizedPosition === true;
            var includeX = options.x !== false;
            var includeY = options.y !== false;
            var sign = String(options.mode || "follow").toLowerCase() === "stabilize" ? -1 : 1;
            var sourceToSequenceX = sourceWidth / sequenceWidth;
            var sourceToSequenceY = sourceHeight / sequenceHeight;
            var positions = [];
            var scaleFactors = [];
            for (var i = 0; i < overlap.length; i++) {
                var sample = overlap[i];
                var x = Number(sample.x !== undefined ? sample.x : sample.position && sample.position.x);
                var y = Number(sample.y !== undefined ? sample.y : sample.position && sample.position.y);
                var sequenceTime = Number(sample.sequenceTime);
                var seconds = targetIn + ((sequenceTime - targetStart) / targetRate);
                if (!isFinite(x) || !isFinite(y) || !isFinite(sequenceTime) || !isFinite(seconds)) {
                    return { success: false, code: "MOTION_SAMPLE_INVALID", message: "A tracked point or timestamp is invalid.", sampleIndex: i };
                }
                var outX, outY;
                // Keep the calibrated tracker-to-target movement mapping.
                var sourceDx = (x - firstX) * sourceWidth;
                var sourceDy = (y - firstY) * sourceHeight;
                var dx = sourceDx * sign;
                var dy = sourceDy * sign;
                outX = baselineX + (includeX ? (normalizedPosition ? dx / sequenceWidth : dx) : 0);
                outY = baselineY + (includeY ? (normalizedPosition ? dy / sequenceHeight : dy) : 0);
                if (!isFinite(outX) || !isFinite(outY)) return { success: false, code: "MOTION_OUTPUT_INVALID", message: "A generated Position value was invalid.", sampleIndex: i };
                positions.push({ seconds: seconds, value: [outX, outY], sequenceTime: sequenceTime });

                if (options.autoScale) {
                    var currentScale = Math.sqrt((Number(sample.width) / Number(first.width)) * (Number(sample.height) / Number(first.height)));
                    if (!isFinite(currentScale) || currentScale <= 0 || currentScale > 100) return { success: false, code: "MOTION_SCALE_INVALID", message: "A validated mask-size ratio was outside the supported range.", sampleIndex: i };
                    scaleFactors.push({ seconds: seconds, sequenceTime: sequenceTime, factor: currentScale,
                        widthFactor: Number(sample.width) / Number(first.width), heightFactor: Number(sample.height) / Number(first.height) });
                }
            }
            return {
                success: true,
                positions: positions,
                scaleFactors: scaleFactors,
                diagnostics: {
                    sourceToSequenceX: sourceToSequenceX,
                    sourceToSequenceY: sourceToSequenceY,
                    coordinateModel: "source-normalized position delta scaled by source frame dimensions; Auto Scale is independent of Position",
                    sourceMotionScaleApplied: false,
                    sourceClipRotationApplied: false,
                    pixelAspectRatioApplied: false,
                    sequenceNestingApplied: false,
                    failures: errors
                }
            };
        }
    };
}());
