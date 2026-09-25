(function (global) {
  "use strict";

  var statusElement, connectionElement, reportElement, copyButton, sourceElement;
  var readButton, applyButton, clearButton;
  var TRACK_KEY = "objectTracker.normalizedTrack.v1";
  var GENERATED_KEY = "objectTracker.generatedKeys.v1";

  function setStatus(message, kind) {
    statusElement.textContent = message;
    statusElement.setAttribute("data-kind", kind || "");
  }

  function showReport(result) {
    var json = JSON.stringify(result, null, 2);
    global.ObjectTrackerState.lastReport = result;
    global.ObjectTrackerState.lastJson = json;
    reportElement.textContent = json;
    copyButton.disabled = false;
  }

  function setBusy(busy, message) {
    global.ObjectTrackerState.busy = busy;
    readButton.disabled = busy || !global.ObjectTrackerState.hostReady;
    applyButton.disabled = busy || !global.ObjectTrackerState.hostReady || !global.ObjectTrackerState.cachedTrack;
    clearButton.disabled = busy || !global.ObjectTrackerState.hostReady || !global.ObjectTrackerState.generatedRecords.length;
    if (message) setStatus(message, "");
  }

  function reportResult(result) {
    showReport(result);
    setStatus((result && result.message) || "Command complete; see the structured report.", result && result.success ? "success" : "warning");
  }

  function runCommand(functionName, pendingMessage) {
    if (global.ObjectTrackerState.busy) return;
    setBusy(true, pendingMessage);
    global.ObjectTrackerBridge.call(functionName, function (result) {
      setBusy(false);
      reportResult(result);
    });
  }

  function saveCachedTrack(track) {
    global.ObjectTrackerState.cachedTrack = track;
    try { localStorage.setItem(TRACK_KEY, JSON.stringify(track)); } catch (error) {}
    var source = track.source || {};
    sourceElement.textContent = (track.sourceClipName || source.sourceClipName || "Tracked clip") +
      " · " + track.sampleCount + " samples · " + ((track.mask && track.mask.instanceName) || "Mask") +
      " · Premiere mask tracker";
    sourceElement.setAttribute("data-ready", "true");
    applyButton.disabled = global.ObjectTrackerState.busy || !global.ObjectTrackerState.hostReady;
  }

  function restoreState() {
    try {
      var savedTrack = localStorage.getItem(TRACK_KEY);
      if (savedTrack) {
        var parsedTrack = JSON.parse(savedTrack);
        if (parsedTrack && parsedTrack.samples && parsedTrack.samples.length >= 2 && parsedTrack.source) saveCachedTrack(parsedTrack);
      }
    } catch (error) { try { localStorage.removeItem(TRACK_KEY); } catch (removeError) {} }
    try {
      var savedRecords = localStorage.getItem(GENERATED_KEY);
      var parsedRecords = savedRecords ? JSON.parse(savedRecords) : [];
      global.ObjectTrackerState.generatedRecords = parsedRecords instanceof Array ? parsedRecords : [];
    } catch (error) { global.ObjectTrackerState.generatedRecords = []; }
    clearButton.disabled = global.ObjectTrackerState.generatedRecords.length === 0;
  }

  function readTrack() {
    if (global.ObjectTrackerState.busy) return;
    setBusy(true, "Reading the selected clip's saved tracker stream…");
    global.ObjectTrackerProjectReader.extractSelected(function (result) {
      setBusy(false);
      if (result && result.success && result.normalizedTrack) {
        result.normalizedTrack.mask = result.mask;
        result.normalizedTrack.trackSourceReport = {
          projectName: result.projectName,
          objectMaskClassification: result.objectMaskClassification,
          trackerParameter: result.trackerParameter,
          timeMapping: result.timeMapping
        };
        saveCachedTrack(result.normalizedTrack);
      }
      reportResult(result);
      if (result && result.success) setStatus("Track loaded: " + result.normalizedTrack.sampleCount + " samples. Select a target clip and apply.", "success");
    });
  }

  function selectedMode() {
    var selected = document.querySelector('input[name="trackMode"]:checked');
    return selected ? selected.value : "follow";
  }

  function applyTrack() {
    if (global.ObjectTrackerState.busy || !global.ObjectTrackerState.cachedTrack) return;
    var options = {
      mode: selectedMode(),
      x: document.getElementById("xAxis").checked,
      y: document.getElementById("yAxis").checked
    };
    if (!options.x && !options.y) { setStatus("Choose at least one Position axis.", "warning"); return; }
    setBusy(true, "Adding or finding Transform and writing Position keys…");
    global.ObjectTrackerBridge.callWithArguments("applyTrackToSelectedTarget", [JSON.stringify(global.ObjectTrackerState.cachedTrack), JSON.stringify(options)], function (result) {
      setBusy(false);
      reportResult(result);
      if (result && result.success && result.generatedKeys && result.generatedKeys.length) {
        var record = {
          targetNodeId: result.targetNodeId,
          sequenceId: result.sequenceId,
          transformMatchName: result.transform.matchName,
          generatedKeys: result.generatedKeys,
          baseline: result.baseline,
          initialTimeVarying: result.initialTimeVarying,
          initialKeyCount: result.initialKeyCount,
          targetClip: result.targetClip,
          mode: result.mode
        };
        var records = global.ObjectTrackerState.generatedRecords;
        var found = -1;
        for (var i = 0; i < records.length; i++) if (String(records[i].targetNodeId) === String(record.targetNodeId) && String(records[i].sequenceId) === String(record.sequenceId)) found = i;
        if (found >= 0) records[found] = record;
        else records.push(record);
        try { localStorage.setItem(GENERATED_KEY, JSON.stringify(records)); } catch (error) {}
        clearButton.disabled = false;
        setStatus("Wrote and verified " + result.keyCount + " Transform Position keys on “" + result.targetClip + "”.", "success");
      }
    });
  }

  function clearGeneratedKeys() {
    if (global.ObjectTrackerState.busy || !global.ObjectTrackerState.generatedRecords.length) return;
    setBusy(true, "Checking selected target and removing only recorded keys…");
    global.ObjectTrackerBridge.call("savedProjectContext", function (context) {
      if (!context || !context.success) { setBusy(false); reportResult(context); return; }
      var selected = context.selectedVideoClips || [];
      if (selected.length !== 1) {
        setBusy(false);
        reportResult({ success: false, stage: "clear-generated-keys", code: "SELECT_RECORDED_TARGET", message: "Select the same target clip that received Object Tracker's keys." });
        return;
      }
      var record = null;
      for (var i = 0; i < global.ObjectTrackerState.generatedRecords.length; i++) {
        var candidate = global.ObjectTrackerState.generatedRecords[i];
        if (String(candidate.targetNodeId) === String(selected[0].nodeId) && String(candidate.sequenceId) === String(context.sequenceId)) { record = candidate; break; }
      }
      if (!record) {
        setBusy(false);
        reportResult({ success: false, stage: "clear-generated-keys", code: "NO_GENERATED_KEYS_FOR_TARGET", message: "No Object Tracker key record matches the selected clip." });
        return;
      }
      global.ObjectTrackerBridge.callWithArguments("clearGeneratedPositionKeys", [JSON.stringify(record)], function (result) {
        setBusy(false);
        reportResult(result);
        if (result && result.success) {
          global.ObjectTrackerState.generatedRecords = global.ObjectTrackerState.generatedRecords.filter(function (entry) {
            return !(String(entry.targetNodeId) === String(record.targetNodeId) && String(entry.sequenceId) === String(record.sequenceId));
          });
          try { localStorage.setItem(GENERATED_KEY, JSON.stringify(global.ObjectTrackerState.generatedRecords)); } catch (error) {}
          clearButton.disabled = global.ObjectTrackerState.generatedRecords.length === 0;
          if (result.changedKeyCount) setStatus("Removed " + result.removedKeyCount + " generated keys; " + result.changedKeyCount + " edited keys were kept.", "warning");
        }
      });
    });
  }

  function copyReport() {
    var text = global.ObjectTrackerState.lastJson;
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { setStatus("JSON copied to clipboard.", "success"); }, function () { setStatus("Clipboard access was denied. The report remains visible below.", "warning"); });
      return;
    }
    var temporary = document.createElement("textarea");
    temporary.value = text;
    temporary.setAttribute("readonly", "readonly");
    temporary.style.position = "fixed";
    temporary.style.left = "-10000px";
    document.body.appendChild(temporary);
    temporary.select();
    var copied = false;
    try { copied = document.execCommand("copy"); } catch (error) { copied = false; }
    document.body.removeChild(temporary);
    setStatus(copied ? "JSON copied to clipboard." : "Copy failed; the report remains visible below.", copied ? "success" : "warning");
  }

  global.ObjectTrackerUI = {
    initialize: function () {
      statusElement = document.getElementById("resultStatus");
      connectionElement = document.getElementById("connectionStatus");
      reportElement = document.getElementById("report");
      copyButton = document.getElementById("copyButton");
      sourceElement = document.getElementById("trackSource");
      readButton = document.getElementById("readTrackButton");
      applyButton = document.getElementById("applyTrackButton");
      clearButton = document.getElementById("clearKeysButton");
      readButton.disabled = true;
      applyButton.disabled = true;
      clearButton.disabled = true;
      restoreState();

      readButton.addEventListener("click", readTrack);
      applyButton.addEventListener("click", applyTrack);
      clearButton.addEventListener("click", clearGeneratedKeys);
      document.getElementById("inspectButton").addEventListener("click", function () { runCommand("inspectSelectedClip", "Inspecting selected timeline clip…"); });
      document.getElementById("trackButton").addEventListener("click", function () { runCommand("inspectTrackCandidates", "Checking exposed Premiere tracking properties…"); });
      document.getElementById("projectTrackButton").addEventListener("click", function () {
        if (global.ObjectTrackerState.busy) return;
        setBusy(true, "Reading saved Premiere project data…");
        global.ObjectTrackerProjectReader.scan(function (result) { setBusy(false); reportResult(result); });
      });
      copyButton.addEventListener("click", copyReport);

      global.ObjectTrackerBridge.initializeHost(function (result) {
        global.ObjectTrackerState.hostReady = !!(result && result.success);
        if (result && result.success) {
          connectionElement.textContent = "Connected to Premiere Pro " + result.host.version;
          readButton.disabled = false;
          applyButton.disabled = !global.ObjectTrackerState.cachedTrack;
          clearButton.disabled = global.ObjectTrackerState.generatedRecords.length === 0;
          setStatus(global.ObjectTrackerState.cachedTrack ? "Cached track ready. Select a target and apply." : "Select a timeline clip with a tracked Premiere mask.", "success");
        } else {
          connectionElement.textContent = "Premiere connection unavailable";
          setStatus((result && result.message) || "Could not initialize the ExtendScript bridge.", "error");
          showReport(result);
        }
      });
    }
  };
}(window));
