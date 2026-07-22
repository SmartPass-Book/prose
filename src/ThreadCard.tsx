import { useEffect, useState } from "react";
import type { ReviewThread } from "./types";
import type { Anchor, AnchorMatch } from "./anchors";
import { stripAnchorFromBody, stripMarkerFromBody } from "./anchors";

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

export interface ThreadCardProps {
  thread: ReviewThread;
  anchor: Anchor | null;
  matchState: AnchorMatch | null;
  currentUser: string | null;
  highlighted: boolean;
  registerEl: (el: HTMLElement | null) => void;
  onActivate: () => void;
  onResolve: () => void;
  onReply: (body: string) => void;
  onDelete: (commentId: number) => void;
  onRetryOp: (opId: string) => void;
  onDiscardOp: (opId: string) => void;
  style?: React.CSSProperties;
  extraClass?: string;
}

// pendingOp is `<op-id>` while a write is in flight and `failed:<op-id>`
// once it has permanently failed. Returns the bare op id for the failed case.
function failedOpId(pendingOp: string | null | undefined): string | null {
  if (!pendingOp || !pendingOp.startsWith("failed:")) return null;
  return pendingOp.slice("failed:".length);
}

export function ThreadCard({
  thread,
  anchor,
  matchState,
  currentUser,
  highlighted,
  registerEl,
  onActivate,
  onResolve,
  onReply,
  onDelete,
  onRetryOp,
  onDiscardOp,
  style,
  extraClass,
}: ThreadCardProps) {
  const [reply, setReply] = useState("");
  const [open, setOpen] = useState(false);
  // A file-level thread has no line: it was posted with subject_type: file
  // because the passage sits outside the PR diff. The anchor pill below
  // already shows what it points at, so label the level instead of "L?".
  const ln = thread.line ?? thread.originalLine ?? null;
  const hasFailed = thread.comments.nodes.some((c) => failedOpId(c.pendingOp));
  const isPending =
    !hasFailed &&
    thread.comments.nodes.some((c) => c.pendingOp && !failedOpId(c.pendingOp));
  return (
    <li
      ref={registerEl}
      className={`thread ${thread.isResolved ? "resolved" : ""} ${highlighted ? "highlighted" : ""} ${hasFailed ? "failed" : ""} ${isPending ? "pending" : ""} ${extraClass ?? ""}`}
      onClick={onActivate}
      data-thread-id={thread.clientKey}
      style={style}
    >
      <div className="thread-meta">
        <span className="line-btn" title={ln ? `Line ${ln}` : "Anchored to text, not a diff line"}>
          {ln ? `L${ln}` : "file"}
        </span>
        <span className="status">
          {hasFailed
            ? "not sent"
            : isPending
              ? "sending…"
              : thread.isResolved
                ? "resolved"
                : thread.isOutdated
                  ? "outdated"
                  : "open"}
        </span>
        <button
          className="resolve-btn"
          onClick={(e) => {
            e.stopPropagation();
            onResolve();
          }}
        >
          {thread.isResolved ? "Unresolve" : "Resolve"}
        </button>
      </div>
      {anchor && (
        <div className={`anchor-row ${matchState ?? ""}`}>
          <span className="anchor-pill">{truncate(anchor.exact, 80)}</span>
          {matchState === "recovered" && (
            <span className="anchor-badge recovered" title="Anchor recovered nearby">
              recovered
            </span>
          )}
          {matchState === "stale" && (
            <span className="anchor-badge stale" title="Anchor text not found in source">
              stale
            </span>
          )}
        </div>
      )}
      <ul className="comments">
        {thread.comments.nodes.map((c, idx) => {
          const isMine = currentUser !== null && c.author?.login === currentUser;
          const failedOp = failedOpId(c.pendingOp);
          return (
            <li key={c.id} className={failedOp ? "failed" : ""}>
              <div className="comment-author">
                <span>
                  {c.author?.login} · {new Date(c.createdAt).toLocaleString()}
                </span>
                {isMine && !c.pendingOp && (
                  <DeleteButton onConfirm={() => onDelete(c.databaseId)} />
                )}
              </div>
              <div className="comment-body">
                {idx === 0 ? stripAnchorFromBody(c.body) : stripMarkerFromBody(c.body)}
              </div>
              {failedOp && (
                <div className="comment-failed" onClick={(e) => e.stopPropagation()}>
                  <span className="comment-failed-note">
                    Not saved to GitHub. Your text is kept here.
                  </span>
                  <div className="comment-failed-actions">
                    <button
                      className="primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRetryOp(failedOp);
                      }}
                    >
                      Retry
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void navigator.clipboard?.writeText(
                          idx === 0 ? stripAnchorFromBody(c.body) : stripMarkerFromBody(c.body),
                        );
                      }}
                    >
                      Copy text
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDiscardOp(failedOp);
                      }}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {open ? (
        <div className="reply" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                if (!reply.trim()) return;
                e.preventDefault();
                onReply(reply);
                setReply("");
                setOpen(false);
              }
            }}
            placeholder="Reply..."
            autoFocus
          />
          <div className="reply-actions">
            <button
              onClick={() => {
                setOpen(false);
                setReply("");
              }}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={!reply.trim()}
              onClick={() => {
                onReply(reply);
                setReply("");
                setOpen(false);
              }}
            >
              Reply
            </button>
          </div>
        </div>
      ) : (
        <button
          className="reply-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          Reply
        </button>
      )}
    </li>
  );
}

function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      className={`trash-btn ${armed ? "armed" : ""}`}
      title={armed ? "Click again to confirm" : "Delete comment"}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      aria-label={armed ? "Confirm delete" : "Delete comment"}
    >
      {armed ? (
        <span className="trash-confirm">Delete?</span>
      ) : (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            fill="currentColor"
            d="M5.5 1.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5V2h3a.5.5 0 0 1 0 1h-.62l-.7 10.43A2 2 0 0 1 10.18 15H5.82a2 2 0 0 1-2-1.57L3.12 3H2.5a.5.5 0 0 1 0-1h3v-.5zm1 .5V2h3v-.5h-3zM4.13 3l.69 10.29a1 1 0 0 0 1 .71h4.36a1 1 0 0 0 1-.71L11.87 3H4.13zM6.5 5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 .5-.5zm3 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 .5-.5z"
          />
        </svg>
      )}
    </button>
  );
}
