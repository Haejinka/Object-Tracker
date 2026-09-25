(function (global) {
  "use strict";

  global.ObjectTrackerState = {
    hostReady: false,
    busy: false,
    lastReport: null,
    lastJson: "",
    cachedTrack: null,
    generatedRecords: []
  };
}(window));
