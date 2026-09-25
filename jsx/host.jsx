(function () {
    $._ObjectTracker = $._ObjectTracker || {};
    $._ObjectTracker.version = "0.1.0";
    $._ObjectTracker.loadErrors = [];

    $._ObjectTracker.hostInfo = function () {
        var loadErrors = $._ObjectTracker.loadErrors || [];
        return JSON.stringify({
            success: loadErrors.length === 0,
            stage: loadErrors.length === 0 ? "cep-host-bridge" : "cep-host-bootstrap",
            code: loadErrors.length === 0 ? undefined : "HOST_MODULE_LOAD_FAILED",
            message: loadErrors.length === 0
                ? "CEP panel is connected to Premiere ExtendScript."
                : "Premiere connected, but one or more Object Tracker host modules failed to load.",
            errors: loadErrors,
            host: {
                application: "Premiere Pro",
                version: app.version,
                build: app.build,
                extensionVersion: $._ObjectTracker.version
            }
        });
    };

    // CEP supplies the extension root. $.fileName can point at Premiere's
    // current project folder, so it is not a reliable base for module paths.
    $._ObjectTracker.loadModules = function (extensionRoot) {
        var jsxFolder = new Folder(String(extensionRoot) + "/jsx");
        var files = ["utilities.jsx", "inspector.jsx", "tracker.jsx", "motion-solver.jsx", "transform.jsx", "project.jsx"];
        var loadErrors = $._ObjectTracker.loadErrors;
        loadErrors.length = 0;

        for (var i = 0; i < files.length; i++) {
            var moduleFile = new File(jsxFolder.fsName + "/" + files[i]);
            try {
                if (!moduleFile.exists) {
                    loadErrors.push(files[i] + ": file not found at " + moduleFile.fsName);
                } else {
                    $.evalFile(moduleFile);
                }
            } catch (error) {
                loadErrors.push(files[i] + ": " + String(error));
            }
        }

        return $._ObjectTracker.hostInfo();
    };
}());
