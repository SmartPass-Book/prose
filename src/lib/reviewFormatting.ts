export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function activityFreshness(iso: string): "fresh" | "recent" | "stale" {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 5 * 60_000) return "fresh";
  if (ms < 60 * 60_000) return "recent";
  return "stale";
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}
