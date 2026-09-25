#!/usr/bin/env node
// Run the real saved-project reader against a known TrackItem in a .prproj.
// Usage: node tests/project-reader-sample.js <project.prproj> <track-item-id> [premiere-version] [--expect-object-mask|--expect-classic-mask]

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node tests/project-reader-sample.js <project.prproj> <track-item-id> [premiere-version] [--expect-object-mask|--expect-classic-mask]");
  process.exit(2);
}

const projectPath = path.resolve(args[0]);
const trackItemId = String(args[1]);
const runtimeRoot = process.env.OBJECT_TRACKER_RUNTIME || path.join(__dirname, "..");
const premiereVersion = args[2] && !args[2].startsWith("--") ? args[2] : "26.3.2";
const expectObjectMask = args.includes("--expect-object-mask");
const expectClassicMask = args.includes("--expect-classic-mask");
const bytes = fs.readFileSync(projectPath);
const compressed = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
const xml = (compressed ? zlib.gunzipSync(bytes) : bytes).toString("utf8").replace(/^\uFEFF/, "");
const sidecarDirectory = path.join(path.dirname(projectPath), path.basename(projectPath, path.extname(projectPath)) + " Masks");
const sidecarFiles = fs.existsSync(sidecarDirectory)
  ? fs.readdirSync(sidecarDirectory).filter(name => /\.prmf$/i.test(name)).map(name => ({ name, bytes: fs.statSync(path.join(sidecarDirectory, name)).size }))
  : [];

global.window = global;
global.ObjectTrackerBridge = {};
require(path.join(runtimeRoot, "js", "object-mask-parser.js"));
require(path.join(runtimeRoot, "js", "tracking-pipeline.js"));
require(path.join(runtimeRoot, "js", "project-reader.js"));

const result = global.ObjectTrackerProjectReader.extractFromXml(xml, { nodeId: trackItemId }, Buffer, {
  premiereVersion,
  fileSignature: compressed ? "gzip" : "xml",
  projectIsGzipXml: compressed,
  projectIsXml: true,
  projectPath,
  sidecarSummary: { directoryPath: sidecarDirectory, exists: fs.existsSync(sidecarDirectory), fileCount: sidecarFiles.length, files: sidecarFiles },
  trackItemId,
  readSidecar: filename => fs.readFileSync(path.join(sidecarDirectory, filename))
});

if (expectObjectMask) {
  assert.strictEqual(result.success, true, "the selected TrackItem should decode validated PRMF v3 Object Mask rectangles");
  assert.strictEqual(result.objectMaskClassification, "object-mask");
  assert.strictEqual(result.normalizedTrack.capabilities.bounds, true);
  assert.strictEqual(result.normalizedTrack.capabilities.scale, true);
  assert.strictEqual(result.normalizedTrack.capabilities.rotation, false);
  assert(result.normalizedTrack.sampleCount >= 2);
  assert(result.normalizedTrack.samples.every(sample => Number.isFinite(sample.centerX) && sample.width > 0 && sample.height > 0));
}
if (expectClassicMask) {
  assert.strictEqual(result.success, true, "the selected TrackItem should decode to a supported legacy point stream");
  assert.strictEqual(result.objectMaskClassification, "classic-mask");
  assert.strictEqual(result.normalizedTrack.capabilities.bounds, false);
}

const summary = result.success ? {
  success: result.success,
  code: result.code,
  objectMaskClassification: result.objectMaskClassification,
  mask: result.mask,
  trackerParameter: result.trackerParameter,
  sampleCount: result.normalizedTrack.sampleCount,
  first: result.normalizedTrack.samples[0],
  last: result.normalizedTrack.samples[result.normalizedTrack.samples.length - 1],
  capabilities: result.normalizedTrack.capabilities
} : {
  success: result.success,
  code: result.code,
  objectMaskClassification: result.objectMaskClassification || result.details && result.details.objectMaskClassification,
  masks: (result.details && result.details.masks || []).map(mask => ({
    componentId: mask.componentId,
    classification: mask.classification,
    trackers: (mask.trackers || []).filter(tracker => tracker.sidecarReferenceCount || tracker.keyCount).map(tracker => ({
      parameterId: tracker.parameterId,
      keyCount: tracker.keyCount,
      sidecarReferenceCount: tracker.sidecarReferenceCount,
      sidecarMatches: tracker.sidecarMatches,
      formatDetection: tracker.formatDetection
    }))
  }))
};
console.log(JSON.stringify(summary, null, 2));
