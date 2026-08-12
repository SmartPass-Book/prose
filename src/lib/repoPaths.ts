/// Whether a markdown URL points somewhere the webview can already load.
/// Absolute URLs and inline data are passed through untouched; everything else
/// is a repo-relative path that has to be fetched through the backend.
export function isExternalUrl(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
}

/// Resolve a markdown-relative path against the file that referenced it.
///
/// Chapters link their figures relatively - `chapter-02.md` says
/// `assets/chapter-02/diagram.svg`, meaning
/// `story/abridged/assets/chapter-02/diagram.svg`. Resolution is against the
/// referencing file's *directory*, and `..` segments have to collapse or the
/// path won't match anything in the tree.
///
/// A leading `/` means repo root, not filesystem root.
export function resolveRepoPath(fromFile: string, src: string): string {
    const cleaned = src.split(/[?#]/)[0];
  if (!cleaned) return "";

  const fromRoot = cleaned.startsWith("/");
  const baseDir = fromRoot ? [] : fromFile.split("/").slice(0, -1);
  const segments = [...baseDir, ...cleaned.split("/")];

  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Refuse to climb past the repo root; a path that tries is malformed
      // and dropping the segment keeps it inside the tree.
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}
