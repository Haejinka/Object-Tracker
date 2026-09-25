(function (global) {
  "use strict";

  var statusElement, statusTextElement, connectionElement;
  var sourceElement, sourceTextElement, sourceMetaElement, targetSummary, targetName, targetType;
  var readButton, useSelectionButton, applyButton, applyButtonText, autoScaleInput;
  var modeInputs, axisInputs;
  var trackHasValidatedBounds = false;
  var selectedTargetId = null;
  var TRACK_KEY = "objectTracker.normalizedTrack.v2";
  var statusResetTimer = null;

  function setStatus(message, kind) {
    statusTextElement.textContent = message;
    statusElement.setAttribute("data-kind", kind || "");
  }

  function updateControls() {
    var busy = global.ObjectTrackerState.busy;
    var hostReady = global.ObjectTrackerState.hostReady;
    readButton.disabled = busy || !hostReady;
    useSelectionButton.disabled = busy || !hostReady;
    applyButton.disabled = busy || !hostReady || !global.ObjectTrackerState.cachedTrack || !selectedTargetId;
    for (var i = 0; i < modeInputs.length; i++) modeInputs[i].disabled = busy;
    for (var j = 0; j < axisInputs.length; j++) axisInputs[j].disabled = busy;
    updateScaleControl();
  }

  function setBusy(busy, message, stage) {
    global.ObjectTrackerState.busy = busy;
    applyButton.setAttribute("data-busy", busy ? "true" : "false");
    applyButtonText.textContent = busy && stage === "apply" ? "Applying Tracking…" : "Apply Tracking";
    updateControls();
    if (message) setStatus(message, busy ? "busy" : "");
  }

  function friendlyError(result, fallback) {
    var message = result && typeof result.message === "string" ? result.message : "";
    if (!message || /^(Error:|TypeError:|ReferenceError:)/i.test(message)) return fallback;
    return message;
  }

  function showResultError(result, fallback) {
    setStatus(friendlyError(result, fallback), "error");
  }

  function setSourceEmpty(message) {
    sourceTextElement.textContent = message;
    sourceMetaElement.textContent = "";
    sourceElement.removeAttribute("data-ready");
  }

  function saveCachedTrack(track) {
    global.ObjectTrackerState.cachedTrack = track;
    try { localStorage.setItem(TRACK_KEY, JSON.stringify(track)); } catch (error) {}
    var source = track.source || {};
    var maskLabel = source.maskSubtypeClassification === "object-mask" ? "Object Mask" : "Mask track";
    trackHasValidatedBounds = !!(global.ObjectTrackerTrackingPipeline && global.ObjectTrackerTrackingPipeline.hasValidatedBounds(track));
    sourceTextElement.textContent = track.sourceClipName || source.sourceClipName || "Tracked clip";
    sourceMetaElement.textContent = maskLabel + " · " + (track.sampleCount || 0) + " frames";
    sourceElement.setAttribute("data-ready", "true");
    updateControls();
  }

  function clearCachedTrack() {
    global.ObjectTrackerState.cachedTrack = null;
    trackHasValidatedBounds = false;
    try { localStorage.removeItem(TRACK_KEY); } catch (error) {}
    setSourceEmpty("Select the clip with the tracked Object Mask.");
    updateControls();
  }

  function setTargetEmpty(message) {
    selectedTargetId = null;
    targetName.textContent = message || "No target selected";
    targetType.textContent = "";
    targetSummary.setAttribute("data-empty", "true");
    updateControls();
  }

  function setTarget(clip) {
    selectedTargetId = String(clip.nodeId);
    targetName.textContent = clip.name || "Selected timeline clip";
    targetType.textContent = "Timeline clip or graphic";
    targetSummary.removeAttribute("data-empty");
    updateControls();
  }

  function restoreState() {
    try {
      var savedTrack = localStorage.getItem(TRACK_KEY);
      if (savedTrack) {
        var parsedTrack = JSON.parse(savedTrack);
        if (parsedTrack && parsedTrack.samples && parsedTrack.samples.length >= 2 && parsedTrack.source) saveCachedTrack(parsedTrack);
      }
    } catch (error) { try { localStorage.removeItem(TRACK_KEY); } catch (removeError) {} }
    updateControls();
  }

  function readTrack() {
    if (global.ObjectTrackerState.busy || !global.ObjectTrackerState.hostReady) return;
    clearCachedTrack();
    setBusy(true, "Reading Object Mask…", "read");
    global.ObjectTrackerProjectReader.extractSelected(function (result) {
      setBusy(false);
      if (result && result.success && result.normalizedTrack) {
        result.normalizedTrack.mask = result.mask;
        result.normalizedTrack.trackSourceReport = {
          projectName: result.projectName,
          objectMaskClassification: result.objectMaskClassification,
          trackerParameter: result.trackerParameter,
          timeMapping: result.timeMapping,
          formatDetection: result.formatDetection,
          sidecarSummary: result.sidecarSummary
        };
        saveCachedTrack(result.normalizedTrack);
        setStatus("Object Mask detected", "");
      } else {
        showResultError(result, "Could not read a tracked mask. Select the clip with the Object Mask and try again.");
      }
    });
  }

  function useCurrentSelection() {
    if (global.ObjectTrackerState.busy || !global.ObjectTrackerState.hostReady) return;
    setBusy(true, "Reading timeline selection…", "target");
    global.ObjectTrackerBridge.call("savedProjectContext", function (context) {
      setBusy(false);
      if (!context || !context.success) { setTargetEmpty(); showResultError(context, "Could not read the selected target."); return; }
      var clips = context.selectedVideoClips || [];
      if (clips.length !== 1) {
        setTargetEmpty();
        setStatus(clips.length ? "Select one target clip or graphic." : "Select a target clip or graphic in the timeline.", "warning");
        return;
      }
      setTarget(clips[0]);
      setStatus("Target selected", "");
    });
  }

  function selectedMode() {
    var selected = document.querySelector('input[name="trackMode"]:checked');
    return selected ? selected.value : "follow";
  }

  function updateScaleControl() {
    if (!autoScaleInput) return;
    var stabilize = selectedMode() === "stabilize";
    var unavailable = stabilize || !trackHasValidatedBounds;
    if (unavailable) autoScaleInput.checked = false;
    autoScaleInput.disabled = global.ObjectTrackerState.busy || unavailable;
    autoScaleInput.title = stabilize
      ? "Scale tracking is available in Follow mode only."
      : (!trackHasValidatedBounds
        ? "Scale needs validated mask-size data from the detected Object Mask track."
        : "Follows validated changes in the Object Mask size.");
  }

  function applyTrackWithOptions(options) {
    setStatus("Writing Position keyframes…", "busy");
    global.ObjectTrackerBridge.callWithArguments("applyTrackToSelectedTarget", [JSON.stringify(global.ObjectTrackerState.cachedTrack), JSON.stringify(options)], function (result) {
      setBusy(false);
      if (!result || !result.success) {
        showResultError(result, "Tracking could not be applied. Check the selected target clip and try again.");
        return;
      }
      var count = result.generatedKeys ? result.generatedKeys.length : 0;
      setStatus("Tracking applied" + (count ? " · " + count + " frames" : ""), "success");
      if (statusResetTimer) clearTimeout(statusResetTimer);
      statusResetTimer = setTimeout(function () {
        if (!global.ObjectTrackerState.busy) setStatus("Ready", "");
      }, 4500);
    });
  }

  function applyTrack() {
    if (global.ObjectTrackerState.busy || !global.ObjectTrackerState.cachedTrack || !selectedTargetId) return;
    var options = {
      mode: selectedMode(),
      autoScale: autoScaleInput.checked,
      x: document.getElementById("xAxis").checked,
      y: document.getElementById("yAxis").checked
    };
    if (options.autoScale && !trackHasValidatedBounds) {
      setStatus("Scale needs validated mask-size data. Detect the Object Mask track again.", "warning");
      return;
    }
    if (!options.x && !options.y) { setStatus("Choose X, Y, or both for Position.", "warning"); return; }
    setBusy(true, "Applying Tracking…", "apply");
    global.ObjectTrackerBridge.call("savedProjectContext", function (context) {
      if (!context || !context.success) {
        setBusy(false);
        showResultError(context, "Could not confirm the selected target.");
        return;
      }
      var clips = context.selectedVideoClips || [];
      if (clips.length !== 1 || String(clips[0].nodeId) !== selectedTargetId) {
        setBusy(false);
        setStatus("Select the chosen target in the timeline, then apply tracking.", "warning");
        return;
      }
      applyTrackWithOptions(options);
    });
  }

  global.ObjectTrackerUI = {
    initialize: function () {
      statusElement = document.getElementById("resultStatus");
      statusTextElement = document.getElementById("statusText");
      connectionElement = document.getElementById("connectionStatus");
      sourceElement = document.getElementById("trackSource");
      sourceTextElement = document.getElementById("trackSourceText");
      sourceMetaElement = document.getElementById("trackTrackMeta");
      targetSummary = document.getElementById("targetSummary");
      targetName = document.getElementById("targetName");
      targetType = document.getElementById("targetType");
      readButton = document.getElementById("readTrackButton");
      useSelectionButton = document.getElementById("useSelectionButton");
      applyButton = document.getElementById("applyTrackButton");
      applyButtonText = document.getElementById("applyButtonText");
      autoScaleInput = document.getElementById("autoScale");
      modeInputs = document.querySelectorAll('input[name="trackMode"]');
      axisInputs = [document.getElementById("xAxis"), document.getElementById("yAxis")];
      for (var modeIndex = 0; modeIndex < modeInputs.length; modeIndex++) modeInputs[modeIndex].addEventListener("change", updateControls);
      setTargetEmpty();
      setSourceEmpty("Select the clip with the tracked Object Mask.");
      restoreState();

      readButton.addEventListener("click", readTrack);
      useSelectionButton.addEventListener("click", useCurrentSelection);
      applyButton.addEventListener("click", applyTrack);
      global.ObjectTrackerBridge.initializeHost(function (result) {
        global.ObjectTrackerState.hostReady = !!(result && result.success);
        if (result && result.success) {
          connectionElement.textContent = "Premiere Pro " + result.host.version;
          updateControls();
          setStatus(global.ObjectTrackerState.cachedTrack ? "Tracked mask ready" : "Ready", "");
        } else {
          connectionElement.textContent = "Premiere connection unavailable";
          setStatus("Premiere connection unavailable. Reopen the panel and try again.", "error");
        }
      });
    }
  };
}(window));
