import type { ReviewThread } from "../types";

/**
 * Whether the signed-in user has a stake in a thread.
 *
 * Participation, not authorship of the opening comment: a thread you only
 * replied to still carries your words, and the "only my comments" filter
 * exists to keep your own review pass readable, not to strip your replies out
 * of it. Optimistic rows count too - the backend stamps them with the cached
 * login before the write leaves the outbox, so a note you just wrote does not
 * blink out of the margin while the filter is on.
 *
 * With no known user (the login has not resolved yet) every thread counts as
 * yours, so the filter fails open rather than blanking the margin.
 */
export function isOwnThread(
  thread: ReviewThread,
  currentUser: string | null,
): boolean {
  if (!currentUser) return true;
  return thread.comments.nodes.some(
    (comment) => comment.author?.login === currentUser,
  );
}
