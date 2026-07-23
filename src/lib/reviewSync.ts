import type { ReviewThread } from "../types";

export function friendlyOutboxError(raw: string): string {
  const error = raw.toLowerCase();
  if (error.includes("422") || error.includes("unprocessable")) {
    if (
      error.includes("line") ||
      error.includes("diff") ||
      error.includes("position")
    ) {
      return "GitHub rejected the line: review comments can only go on lines that are part of this PR's diff.";
    }
    return "GitHub rejected the request as invalid.";
  }
  if (error.includes("401") || error.includes("bad credentials")) {
    return "GitHub rejected the credentials. Try `gh auth login` and retry.";
  }
  if (error.includes("403") || error.includes("rate limit")) {
    return "GitHub refused the request (permissions or rate limit).";
  }
  if (error.includes("404")) {
    return "GitHub couldn't find the PR or commit - it may have been force-pushed.";
  }
  if (
    error.includes("timed out") ||
    error.includes("timeout") ||
    error.includes("dns") ||
    error.includes("connect")
  ) {
    return "Couldn't reach GitHub.";
  }
  return raw.length > 160 ? raw.slice(0, 159) + "…" : raw;
}

export function threadsEqual(a: ReviewThread[], b: ReviewThread[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let threadIndex = 0; threadIndex < a.length; threadIndex++) {
    const left = a[threadIndex];
    const right = b[threadIndex];
    if (
      left.id !== right.id ||
      left.isResolved !== right.isResolved ||
      left.isOutdated !== right.isOutdated ||
      left.line !== right.line ||
      left.startLine !== right.startLine ||
      left.originalLine !== right.originalLine ||
      left.path !== right.path ||
      (left.pendingOp ?? null) !== (right.pendingOp ?? null)
    ) {
      return false;
    }
    const leftComments = left.comments.nodes;
    const rightComments = right.comments.nodes;
    if (leftComments.length !== rightComments.length) return false;
    for (let commentIndex = 0; commentIndex < leftComments.length; commentIndex++) {
      if (
        leftComments[commentIndex].id !== rightComments[commentIndex].id ||
        leftComments[commentIndex].body !== rightComments[commentIndex].body ||
        (leftComments[commentIndex].pendingOp ?? null) !==
          (rightComments[commentIndex].pendingOp ?? null)
      ) {
        return false;
      }
    }
  }
  return true;
}
