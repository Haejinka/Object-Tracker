(function (global) {
  "use strict";

  function normalizeAEMaskSamples(samples) {
    var input = samples || [];
    var first = input.length ? input[0] : null;
    var normalized = [];
    for (var i = 0; i < input.length; i++) {
      var sample = input[i];
      normalized.push({
        ticks: sample.ticks,
        sourceTime: sample.sourceTime,
        time: first ? sample.sourceTime - first.sourceTime : sample.sourceTime,
        sequenceTime: sample.sequenceTime,
        timeFromTrackStart: sample.timeFromTrackStart,
        x: sample.x,
        y: sample.y,
        position: { x: sample.x, y: sample.y, coordinateSpace: "source-normalized", semantic: "AEMask2 tracker point; not verified as mask center" },
        centerX: null,
        centerY: null,
        width: null,
        height: null,
        scale: null,
        rotation: null,
        affineScaleEstimate: sample.affineScaleEstimate === undefined ? null : sample.affineScaleEstimate,
        affineScaleConfidence: sample.affineScaleConfidence || "unvalidated",
        confidence: { position: "unvalidated", bounds: "unavailable", size: "unavailable", rotation: "unavailable" }
      });
    }
    return {
      samples: normalized,
      capabilities: { position: true, bounds: false, scale: false, rotation: false },
      representation: "normalized-source-tracker-point",
      extractionConfidence: "unvalidated-position-stream"
    };
  }

  function normalizeObjectMaskSamples(samples) {
    var input = samples || [];
    var first = input.length ? input[0] : null;
    var normalized = [];
    for (var i = 0; i < input.length; i++) {
      var sample = input[i];
      normalized.push({
        frame: sample.frame,
        ticks: String(sample.timeTicks),
        sourceTime: Number(sample.time),
        time: first ? Number(sample.time) - Number(first.time) : Number(sample.time),
        sequenceTime: sample.sequenceTime,
        timeFromTrackStart: sample.timeFromTrackStart,
        x: Number(sample.normalizedCenterX),
        y: Number(sample.normalizedCenterY),
        position: { x: Number(sample.normalizedCenterX), y: Number(sample.normalizedCenterY), coordinateSpace: "source-normalized", semantic: "centroid estimated from the decoded Object Mask outline" },
        left: Number(sample.left),
        top: Number(sample.top),
        right: Number(sample.right),
        bottom: Number(sample.bottom),
        centerX: Number(sample.centerX),
        centerY: Number(sample.centerY),
        width: Number(sample.width),
        height: Number(sample.height),
        normalizedWidth: Number(sample.normalizedWidth),
        normalizedHeight: Number(sample.normalizedHeight),
        sourceWidth: Number(sample.sourceWidth),
        sourceHeight: Number(sample.sourceHeight),
        scale: null,
        rotation: null,
        confidence: { position: "controlled-sample-validated", bounds: "controlled-sample-validated", size: "controlled-sample-validated", rotation: "unavailable" },
        geometrySource: "GDeflate-decoded mask outline",
        geometryProvenance: sample.sourceSidecarUuids || []
      });
    }
    return {
      samples: normalized,
      capabilities: { position: true, bounds: true, scale: true, rotation: false },
      representation: "normalized-source-object-mask-raster-geometry",
      extractionConfidence: "validated-prmf-v3-gdeflate-mask-raster-geometry"
    };
  }

  function hasValidatedBounds(track) {
    if (!track || !track.capabilities || track.capabilities.bounds !== true || track.capabilities.scale !== true) return false;
    var samples = track.samples || [];
    if (samples.length < 2) return false;
    for (var i = 0; i < samples.length; i++) {
      var sample = samples[i];
      if (!isFinite(Number(sample.centerX)) || !isFinite(Number(sample.centerY)) ||
          !isFinite(Number(sample.width)) || !isFinite(Number(sample.height)) ||
          Number(sample.width) <= 0 || Number(sample.height) <= 0) return false;
    }
    return true;
  }

  global.ObjectTrackerTrackingPipeline = {
    normalizeAEMaskSamples: normalizeAEMaskSamples,
    normalizeObjectMaskSamples: normalizeObjectMaskSamples,
    hasValidatedBounds: hasValidatedBounds
  };
}(window));
