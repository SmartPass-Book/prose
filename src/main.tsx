import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { supportsUpdater } from "./lib/platform";
import { checkForUpdates, registerUpdateMenuListener } from "./updater";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// The updater plugin and the native menu it hangs off are desktop-only, so
// neither command exists on iOS.
if (supportsUpdater()) {
  void checkForUpdates();
  void registerUpdateMenuListener();
}
