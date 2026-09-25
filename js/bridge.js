(function (global) {
  "use strict";

  var csInterface = new CSInterface();

  function parseHostResult(raw) {
    if (typeof raw !== "string" || !raw || raw === "EvalScript error.") {
      return {
        success: false,
        stage: "cep-bridge",
        code: "EVALSCRIPT_FAILED",
        message: "Premiere did not return a host result.",
        raw: raw || ""
      };
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      return {
        success: false,
        stage: "cep-bridge",
        code: "INVALID_HOST_JSON",
        message: "The host returned text that was not valid JSON.",
        raw: raw
      };
    }
  }

  global.ObjectTrackerBridge = {
    call: function (functionName, callback) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(functionName)) {
        callback({
          success: false,
          stage: "cep-bridge",
          code: "INVALID_FUNCTION_NAME",
          message: "Rejected an invalid host function name."
        });
        return;
      }

      csInterface.evalScript("$._ObjectTracker." + functionName + "()", function (raw) {
        callback(parseHostResult(raw));
      });
    },

    callWithArguments: function (functionName, argumentList, callback) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(functionName)) {
        callback({ success: false, stage: "cep-bridge", code: "INVALID_FUNCTION_NAME", message: "Rejected an invalid host function name." });
        return;
      }
      if (!(argumentList instanceof Array)) {
        callback({ success: false, stage: "cep-bridge", code: "INVALID_ARGUMENT_LIST", message: "Host arguments must be passed as an array." });
        return;
      }
      var serialized;
      try { serialized = argumentList.map(function (value) { return JSON.stringify(value); }).join(","); }
      catch (error) {
        callback({ success: false, stage: "cep-bridge", code: "ARGUMENT_SERIALIZATION_FAILED", message: "Could not serialize the Premiere host arguments.", detail: String(error) });
        return;
      }
      csInterface.evalScript("$._ObjectTracker." + functionName + "(" + serialized + ")", function (raw) {
        callback(parseHostResult(raw));
      });
    },

    initializeHost: function (callback) {
      var extensionRoot;
      try {
        extensionRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
      } catch (error) {
        callback({
          success: false,
          stage: "cep-bridge",
          code: "EXTENSION_PATH_UNAVAILABLE",
          message: "CEP could not determine the Object Tracker extension folder.",
          detail: String(error)
        });
        return;
      }

      if (!extensionRoot) {
        callback({
          success: false,
          stage: "cep-bridge",
          code: "EXTENSION_PATH_UNAVAILABLE",
          message: "CEP returned an empty Object Tracker extension folder."
        });
        return;
      }

      csInterface.evalScript("$._ObjectTracker.loadModules(" + JSON.stringify(extensionRoot) + ")", function (raw) {
        callback(parseHostResult(raw));
      });
    },

    getHostVersion: function (callback) {
      this.call("hostInfo", callback);
    }
  };
}(window));
