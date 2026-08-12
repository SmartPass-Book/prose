import { useEffect, useMemo, useState } from "react";
import { isExternalUrl, resolveRepoPath } from "../lib/repoPaths";
import { api } from "../services/api";

interface RepoImageProps {
  repo: string;
  /** Commit the figure is read at, so a cached asset is never stale. */
  gitRef: string;
  /** Path of the markdown file that referenced this image. */
  fromFile: string;
  src?: string;
  alt?: string;
  title?: string;
}

/**
 * A figure referenced from a chapter.
 *
 * Chapters point at images with repo-relative paths, and the repo is private,
 * so the webview cannot load them: relative URLs resolve against the dev
 * server or the tauri:// origin, and the bytes need an Authorization header
 * that an `<img src>` cannot carry. The backend fetches them authenticated and
 * returns a data URL.
 *
 * Results are cached per (repo, ref, path) for the life of the process. The
 * anchor-marking pass re-renders the markdown tree often, and without this a
 * chapter with figures would re-request every one of them each time.
 */
const cache = new Map<string, Promise<string>>();

function load(repo: string, gitRef: string, path: string): Promise<string> {
  const key = `${repo}@${gitRef}:${path}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = api.getAssetDataUrl(repo, gitRef, path).catch((error) => {
    // Don't cache failures: a transient network error shouldn't leave the
    // figure permanently broken for the rest of the session.
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

export function RepoImage({
  repo,
  gitRef,
  fromFile,
  src,
  alt,
  title,
}: RepoImageProps) {
  const resolved = useMemo(
    () => (src && !isExternalUrl(src) ? resolveRepoPath(fromFile, src) : null),
    [fromFile, src],
  );

  const [url, setUrl] = useState<string | null>(
    src && isExternalUrl(src) ? src : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!resolved) return;
    let cancelled = false;
    setFailed(false);
    setUrl(null);
    load(repo, gitRef, resolved)
      .then((dataUrl) => {
        if (!cancelled) setUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [gitRef, repo, resolved]);

  if (failed) {
    // The caption is the useful part when the bytes can't be had, so show it
    // rather than a broken-image icon with no explanation.
    return (
      <span className="figure-missing">
        {alt || resolved || "image"} (couldn't load)
      </span>
    );
  }

  if (!url) {
    return <span className="figure-loading">{alt || "Loading figure..."}</span>;
  }

  return <img className="figure" src={url} alt={alt ?? ""} title={title} />;
}
