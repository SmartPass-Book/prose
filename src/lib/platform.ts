/// Whether this webview is running on a phone-sized touch device, which is
/// what decides between the desktop three-pane layout and the mobile stack.
///
/// Tauri's iOS webview is WKWebView, so the user agent still says iPhone/iPad.
/// The pointer check keeps a narrow desktop window from being mistaken for a
/// phone - a resized macOS window is still a mouse-driven desktop app.
export function isMobilePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iosLike = /iPhone|iPod/.test(ua);
  // iPadOS reports as a Mac; the touch-point count is what separates them.
  const iPadLike = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return iosLike || iPadLike;
}

/// The updater plugin is desktop-only now, so the frontend must not call it on
/// iOS - the command isn't registered there and the invoke would reject.
export function supportsUpdater(): boolean {
  return !isMobilePlatform();
}
