const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

global.window = global;
global.$ = { _ObjectTracker: {} };
require(path.join(__dirname, "..", "js", "object-mask-parser.js"));
require(path.join(__dirname, "..", "js", "tracking-pipeline.js"));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "jsx", "motion-solver.jsx"), "utf8"));

function trackerSample(x, y, scale) {
  const blob = Buffer.alloc(104);
  blob.writeUInt32LE(1, 0);
  blob.writeFloatLE(scale, 4);
  blob.writeFloatLE(0, 8);
  blob.writeFloatLE(0, 16);
  blob.writeFloatLE(scale, 20);
  blob.writeFloatLE(x, 64);
  blob.writeFloatLE(y, 68);
  return blob;
}

const parser = global.ObjectTrackerObjectMaskParser;
const bytes = [trackerSample(0, 0, 1), trackerSample(0.5, 0.4, 1), trackerSample(0.6, 0.45, 1.2)];
const trackerKeys = bytes.map((blob, i) => ({ ticksText: String(i * 254016000000), ticks: i * 254016000000, blob }));
const parsed = parser.parse26Tracker({
  keys: trackerKeys
}, { premiereVersion: "26.3.2", fileSignature: "gzip", matchName: "AE.ADBE AEMask2" });
assert.strictEqual(parsed.success, true);
assert.strictEqual(parsed.samples.length, 2);
assert.strictEqual(parsed.samples[0].x, 0.5);
assert.strictEqual(parsed.capabilities.bounds, false);
assert.strictEqual(parsed.capabilities.scale, false);
assert.strictEqual(parsed.formatDetection.parserUsed, "parser-26.x");

const unsupported = parser.parse26Tracker({
  keys: [{ ticksText: "0", ticks: 0, blob: Buffer.alloc(103) }]
}, { premiereVersion: "26.3.2", fileSignature: "gzip", matchName: "AE.ADBE AEMask2" });
assert.strictEqual(unsupported.success, false);
assert.strictEqual(unsupported.formatDetection.parserUsed, "unsupportedFormat");
assert.match(unsupported.reason, /104-byte/);

const unsupported27 = parser.parse26Tracker({
  keys: trackerKeys
}, { premiereVersion: "27.0.0", fileSignature: "gzip", matchName: "AE.ADBE AEMask2" });
assert.strictEqual(unsupported27.success, false);
assert.strictEqual(unsupported27.formatDetection.parserUsed, "unsupportedFormat");

const sidecarHeader = Buffer.alloc(8);
sidecarHeader.write("prmf", 0, "ascii");
sidecarHeader.writeUInt32LE(3, 4);
assert.deepStrictEqual(parser.detectSidecar(sidecarHeader), { signature: "prmf/v3", version: 3, parserUsed: "header-only" });

const normalized = global.ObjectTrackerTrackingPipeline.normalizeAEMaskSamples([
  { ticks: "0", sourceTime: 0, x: 0.5, y: 0.4 },
  { ticks: "1", sourceTime: 1 / 24, x: 0.6, y: 0.45 }
]);
assert.strictEqual(normalized.samples[0].position.coordinateSpace, "source-normalized");
assert.strictEqual(normalized.samples[0].centerX, null);
assert.strictEqual(normalized.samples[0].width, null);
assert.strictEqual(normalized.capabilities.scale, false);
assert.strictEqual(global.ObjectTrackerTrackingPipeline.hasValidatedBounds(normalized), false);

const pointTrack = {
  capabilities: { position: true, bounds: false, scale: false },
  samples: [
    { x: 0.5, y: 0.4, sequenceTime: 0, affineScaleEstimate: 1 },
    { x: 0.6, y: 0.45, sequenceTime: 1, affineScaleEstimate: 2 }
  ]
};
const solved = global.$._ObjectTracker.MotionSolver.solve({
  track: pointTrack,
  overlap: pointTrack.samples,
  options: { mode: "follow", x: true, y: true, autoScale: false },
  sourceWidth: 1920, sourceHeight: 1080, sequenceWidth: 1080, sequenceHeight: 1920,
  targetStart: 0, targetEnd: 2, targetIn: 0, targetRate: 1,
  baselineX: 0.5, baselineY: 0.5, normalizedPosition: true
});
assert.strictEqual(solved.success, true);
assert(Math.abs(solved.positions[1].value[0] - (0.5 + (0.1 * 1920 / 1080))) < 1e-9);
assert(Math.abs(solved.positions[1].value[1] - (0.5 + (0.05 * 1080 / 1920))) < 1e-9);

const blockedScale = global.$._ObjectTracker.MotionSolver.solve({
  track: pointTrack, overlap: pointTrack.samples, options: { autoScale: true },
  sourceWidth: 1920, sourceHeight: 1080, sequenceWidth: 1080, sequenceHeight: 1920,
  targetStart: 0, targetEnd: 2, targetIn: 0, targetRate: 1,
  baselineX: 0.5, baselineY: 0.5, normalizedPosition: true
});
assert.strictEqual(blockedScale.success, false);
assert.strictEqual(blockedScale.code, "TRACK_BOUNDS_UNAVAILABLE");

const boundedTrack = {
  capabilities: { position: true, bounds: true, scale: true },
  samples: [
    { x: 0.5, y: 0.4, width: 0.2, height: 0.3, centerX: 0.5, centerY: 0.4, sequenceTime: 0 },
    { x: 0.6, y: 0.45, width: 0.4, height: 0.3, centerX: 0.6, centerY: 0.45, sequenceTime: 1 }
  ]
};
const bounded = global.$._ObjectTracker.MotionSolver.solve({
  track: boundedTrack, overlap: boundedTrack.samples, options: { autoScale: true, x: true, y: true },
  sourceWidth: 1920, sourceHeight: 1080, sequenceWidth: 1080, sequenceHeight: 1920,
  targetStart: 0, targetEnd: 2, targetIn: 0, targetRate: 1,
  baselineX: 0.5, baselineY: 0.5, normalizedPosition: true
});
assert.strictEqual(bounded.success, true);
assert.strictEqual(bounded.scaleFactors[1].factor, Math.sqrt(2));
assert(Math.abs(bounded.positions[1].value[0] - (0.5 + (0.1 * 1920 / 1080))) < 1e-9);

console.log("tracking-pipeline tests passed");
