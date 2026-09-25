const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const vm = require("vm");

const controlsRoot = path.resolve(process.argv[2] || "C:\\controls");
const manifestPath = path.join(controlsRoot, "object-mask-control-manifest.json");
const controlManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { samples: [] };
global.window = global;
global.$ = { _ObjectTracker: {} };
require(path.join(__dirname, "..", "js", "gdeflate.js"));
require(path.join(__dirname, "..", "js", "object-mask-parser.js"));
require(path.join(__dirname, "..", "js", "tracking-pipeline.js"));
require(path.join(__dirname, "..", "js", "project-reader.js"));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "jsx", "motion-solver.jsx"), "utf8"));

const cases = [
  { behavior: "static", directory: "static", project: "Static.prproj" },
  { behavior: "horizontal", directory: "Horizontal", project: "horizontal.prproj" },
  { behavior: "vertical", directory: "Vertical", project: "vertical.prproj" },
  { behavior: "scale-up", directory: "Scale-up", project: "scale up.prproj" },
  { behavior: "scale-down", directory: "Scale-down", project: "scale-down.prproj" }
];

function readControl(sample, invalidSidecar) {
  const projectPath = path.join(controlsRoot, sample.directory, sample.project);
  const manifestSample = (controlManifest.samples || []).find(item => item.name === sample.behavior);
  const trackItemId = manifestSample ? String(manifestSample.trackItemId) : "71";
  const bytes = fs.readFileSync(projectPath);
  const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const xml = (compressed ? zlib.gunzipSync(bytes) : bytes).toString("utf8").replace(/^\uFEFF/, "");
  const sidecarDirectory = path.join(path.dirname(projectPath), path.basename(projectPath, path.extname(projectPath)) + " Masks");
  const files = fs.readdirSync(sidecarDirectory).filter(name => /\.prmf$/i.test(name));
  const result = global.ObjectTrackerProjectReader.extractFromXml(xml, {
    nodeId: trackItemId, name: sample.behavior, start: "0", end: "169513344000", inPoint: "0", outPoint: "169513344000", sourceWidth: 608, sourceHeight: 1080
  }, Buffer, {
    premiereVersion: "26.3.2",
    projectPath,
    projectXml: xml,
    trackItemId,
    sidecarSummary: { directoryPath: sidecarDirectory, exists: true, fileCount: files.length, files: files.map(name => ({ name })) },
    readSidecar: filename => invalidSidecar ? Buffer.alloc(32) : fs.readFileSync(path.join(sidecarDirectory, filename))
  });
  if (invalidSidecar) return result;
  assert.strictEqual(result.success, true, sample.behavior + ": " + JSON.stringify(result.details || result));
  assert.strictEqual(result.code, "OBJECT_MASK_PRMF_TRACK_EXTRACTED");
  assert.strictEqual(result.normalizedTrack.sampleCount, 20);
  assert.strictEqual(result.normalizedTrack.capabilities.bounds, true);
  assert.strictEqual(result.normalizedTrack.capabilities.scale, true);
  assert.strictEqual(result.normalizedTrack.capabilities.rotation, false);
  assert.strictEqual(result.trackerParameter.decodedRasterCount, 20, sample.behavior + ": every tracked frame must decode a mask raster");
  assert.strictEqual(result.formatDetection.parserUsed, "parser-26.x-prmf-v3-gdeflate-mask-raster");
  assert.strictEqual(global.ObjectTrackerTrackingPipeline.hasValidatedBounds(result.normalizedTrack), true);
  assert(result.normalizedTrack.samples.every(frame => Number.isFinite(frame.x) && Number.isFinite(frame.y) && frame.width > 0 && frame.height > 0));
  assert(result.normalizedTrack.samples.every(frame => frame.geometrySource === "GDeflate-decoded mask outline"));
  assert(result.normalizedTrack.samples.every(frame => Number.isFinite(frame.sequenceTime)), sample.behavior + ": source times must map to sequence time");
  assert(result.normalizedTrack.samples.every((frame, index, all) => !index || frame.sequenceTime > all[index - 1].sequenceTime), sample.behavior + ": sequence times must be strictly increasing");
  const frames = result.normalizedTrack.samples;
  return { behavior: sample.behavior, result, frames };
}

const referenceRasterHashes = require(path.join(__dirname, "fixtures", "object-mask-gdeflate-reference-hashes.json"));
for (const sample of cases) {
  const directory = path.join(controlsRoot, sample.directory, path.basename(sample.project, path.extname(sample.project)) + " Masks");
  const files = fs.readdirSync(directory).filter(name => /\.prmf$/i.test(name)).map(filename => ({
    filename,
    bytes: fs.readFileSync(path.join(directory, filename))
  }));
  const temporal = files.map(item => ({ item, parsed: global.ObjectTrackerObjectMaskParser.parsePrmfV3(item.bytes) }))
    .filter(candidate => candidate.parsed.frameCount > 1)
    .sort((a, b) => b.parsed.frameCount - a.parsed.frameCount)[0];
  assert(temporal, sample.behavior + ": temporal PRMF sidecar must exist");
  for (const frameIndex of [0, 19]) {
    const frame = temporal.parsed.frames.find(item => item.payloadIndex === frameIndex);
    assert(frame, sample.behavior + ": expected frame " + frameIndex + " must exist");
    const payload = temporal.item.bytes.subarray(frame.payloadOffset, frame.payloadOffset + frame.payloadBytes);
    const raster = global.ObjectTrackerGDeflate.decode(payload, frame.width * frame.height);
    const digest = crypto.createHash("sha256").update(raster).digest("hex");
    assert.strictEqual(digest, referenceRasterHashes[sample.behavior][String(frameIndex)], sample.behavior + " frame " + frameIndex + ": GDeflate raster must match the independent reference decoder");
  }
}

function range(values) { return Math.max(...values) - Math.min(...values); }
function movement(control, axis) { return control.frames[control.frames.length - 1][axis] - control.frames[0][axis]; }
function trendFraction(values, direction, tolerance) {
  const steps = values.slice(1).map((value, index) => value - values[index]);
  const passed = steps.filter(step => direction === "up" ? step >= -tolerance : step <= tolerance).length;
  return steps.length ? passed / steps.length : 0;
}

const controls = {};
for (const item of cases) controls[item.behavior] = readControl(item);
const rejectedObjectMask = readControl({ behavior: "static", directory: "static", project: "Static.prproj" }, true);
assert.strictEqual(rejectedObjectMask.success, false, "invalid sidecar data must not fall back to point samples");
assert.strictEqual(rejectedObjectMask.code, "NO_DECODED_AEMASK2_MASK_TRACK");
assert.strictEqual(rejectedObjectMask.objectMaskClassification, "unconfirmed");
assert((rejectedObjectMask.details.masks || []).some(mask => (mask.trackers || []).some(tracker => tracker.sidecarMatchCount || (tracker.sidecarMatches || []).length)), "invalid linked PRMF data must be reported without being called a decoded Object Mask track");
const staticFrames = controls.static.frames;
assert(range(staticFrames.map(frame => frame.centerX)) <= 3, "static center X must remain stable");
assert(range(staticFrames.map(frame => frame.centerY)) <= 3, "static center Y must remain stable");
assert(range(staticFrames.map(frame => frame.width)) <= 3, "static width must remain stable");
assert(range(staticFrames.map(frame => frame.height)) <= 3, "static height must remain stable");

const horizontal = controls.horizontal.frames;
assert(Math.abs(movement(controls.horizontal, "centerX")) >= 10, "horizontal control must move in X");
assert(range(horizontal.map(frame => frame.centerY)) <= 3, "horizontal control must keep Y stable");
assert(range(horizontal.map(frame => frame.width)) <= 3 && range(horizontal.map(frame => frame.height)) <= 3, "horizontal control must keep size stable");

const vertical = controls.vertical.frames;
assert(Math.abs(movement(controls.vertical, "centerY")) >= 10, "vertical control must move in Y");
assert(range(vertical.map(frame => frame.centerX)) <= 3, "vertical control must keep X stable");
assert(range(vertical.map(frame => frame.width)) <= 3 && range(vertical.map(frame => frame.height)) <= 3, "vertical control must keep size stable");

const up = controls["scale-up"].frames;
const down = controls["scale-down"].frames;
assert(up[up.length - 1].width / up[0].width >= 1.1, "scale-up must enlarge width");
assert(up[up.length - 1].height / up[0].height >= 1.1, "scale-up must enlarge height");
assert(trendFraction(up.map(frame => frame.width), "up", 1) >= 0.8, "scale-up width trend must be monotonic");
assert(trendFraction(up.map(frame => frame.height), "up", 1) >= 0.8, "scale-up height trend must be monotonic");
assert(down[down.length - 1].width / down[0].width <= 0.9, "scale-down must shrink width");
assert(down[down.length - 1].height / down[0].height <= 0.9, "scale-down must shrink height");
assert(trendFraction(down.map(frame => frame.width), "down", 1) >= 0.8, "scale-down width trend must be monotonic");
assert(trendFraction(down.map(frame => frame.height), "down", 1) >= 0.8, "scale-down height trend must be monotonic");

function solveFollow(control) {
  const track = Object.assign({}, control.result.normalizedTrack, {
    samples: control.frames.map(frame => Object.assign({}, frame, { sequenceTime: frame.sourceTime }))
  });
  const solved = global.$._ObjectTracker.MotionSolver.solve({
    track,
    overlap: track.samples,
    options: { mode: "follow", x: true, y: true, autoScale: true },
    sourceWidth: track.source.sourceWidth,
    sourceHeight: track.source.sourceHeight,
    sequenceWidth: 1920,
    sequenceHeight: 1080,
    targetStart: track.samples[0].sequenceTime,
    targetEnd: track.samples[track.samples.length - 1].sequenceTime + 1 / 30,
    targetIn: 0,
    targetRate: 1,
    baselineX: 0.5,
    baselineY: 0.5,
    normalizedPosition: true
  });
  assert.strictEqual(solved.success, true);
  assert.deepStrictEqual(solved.positions[0].value, [0.5, 0.5], "the target Position baseline must be preserved at the reference frame");
  assert.strictEqual(solved.scaleFactors[0].factor, 1, "the reference target Scale must be preserved");
  return solved;
}
const solvedUp = solveFollow(controls["scale-up"]);
const solvedDown = solveFollow(controls["scale-down"]);
assert(solvedUp.scaleFactors[solvedUp.scaleFactors.length - 1].factor > 1, "Auto Scale must grow the graphic when the object grows");
assert(solvedDown.scaleFactors[solvedDown.scaleFactors.length - 1].factor < 1, "Auto Scale must shrink the graphic when the object shrinks");
assert(Math.abs(solvedUp.positions[solvedUp.positions.length - 1].value[0] - (0.5 + (up[up.length - 1].x - up[0].x) * 608 / 1920)) < 1e-12,
  "Position must follow the Object Mask center using source-to-sequence width conversion");
assert(Math.abs(solvedUp.positions[solvedUp.positions.length - 1].value[1] - (0.5 + (up[up.length - 1].y - up[0].y))) < 1e-12,
  "Position must follow the Object Mask center independently of object size");
assert.strictEqual(100 * solvedUp.scaleFactors[solvedUp.scaleFactors.length - 1].factor,
  100 * Math.sqrt((up[up.length - 1].width / up[0].width) * (up[up.length - 1].height / up[0].height)));
assert.strictEqual(100 * solvedDown.scaleFactors[solvedDown.scaleFactors.length - 1].factor,
  100 * Math.sqrt((down[down.length - 1].width / down[0].width) * (down[down.length - 1].height / down[0].height)));

const staticProject = path.join(controlsRoot, "static", "Static.prproj");
const staticMaskDirectory = path.join(path.dirname(staticProject), "Static Masks");
const temporalStaticFile = fs.readdirSync(staticMaskDirectory).map(name => ({ name, bytes: fs.readFileSync(path.join(staticMaskDirectory, name)) }))
  .filter(item => global.ObjectTrackerObjectMaskParser.parsePrmfV3(item.bytes).frameCount > 1)[0];
const duplicateUnion = global.ObjectTrackerObjectMaskParser.decodeObjectMaskSidecars([
  { uuid: "fixture-a", file: temporalStaticFile.name, bytes: temporalStaticFile.bytes },
  { uuid: "fixture-b", file: temporalStaticFile.name, bytes: temporalStaticFile.bytes }
], controls.static.frames.map(frame => Number(frame.ticks)), { premiereVersion: "26.3.2" });
assert.strictEqual(duplicateUnion.samples.length, 20, "exact cross-sidecar duplicates should collapse to one row per time");
assert(duplicateUnion.samples.every(frame => frame.sourceFrameCount === 2), "each merged frame should retain both source observations");

assert.throws(() => global.ObjectTrackerObjectMaskParser.decodeObjectMaskSidecars([
  { uuid: "bad", file: "bad.prmf", bytes: Buffer.alloc(32) }
], controls.static.frames.map(frame => Number(frame.ticks)), { premiereVersion: "26.3.2" }), /PRMF v3/,
"invalid Object Mask bytes must fail closed");

const summary = {};
Object.keys(controls).forEach(name => {
  const frames = controls[name].frames;
  summary[name] = {
    frameCount: frames.length,
    sourceDimensions: [frames[0].sourceWidth, frames[0].sourceHeight],
    firstCenter: [frames[0].centerX, frames[0].centerY],
    lastCenter: [frames[frames.length - 1].centerX, frames[frames.length - 1].centerY],
    firstSize: [frames[0].width, frames[0].height],
    lastSize: [frames[frames.length - 1].width, frames[frames.length - 1].height],
    untimedReferenceCount: controls[name].result.trackerParameter.untimedReferenceCandidates.length
  };
});
console.log(JSON.stringify({ success: true, summary }, null, 2));
