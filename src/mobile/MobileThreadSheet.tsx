import { useState } from "react";
import { stripAnchorFromBody, stripMarkerFromBody } from "../lib/anchors";
import { relativeTime } from "../lib/reviewFormatting";
import type { ReviewThread } from "../types";

interface MobileThreadSheetProps {
  threads: ReviewThread[];
  currentUser: string | null;
  onClose: () => void;
  onResolve: (thread: ReviewThread) => void;
  onReply: (thread: ReviewThread, body: string) => void;
  onDelete: (commentId: number) => void;
  onRetryOp: (opId: string) => void;
  onDiscardOp: (opId: string) => void;
}

// pendingOp is `<op-id>` while a write is in flight and `failed:<op-id>` once
// it has permanently failed. Returns the bare op id for the failed case.
function failedOpId(pendingOp: string | null | undefined): string | null {
  if (!pendingOp || !pendingOp.startsWith("failed:")) return null;
  return pendingOp.slice("failed:".length);
}

function Note({
  thread,
  currentUser,
  onResolve,
  onReply,
  onDelete,
  onRetryOp,
  onDiscardOp,
}: {
  thread: ReviewThread;
  currentUser: string | null;
  onResolve: (thread: ReviewThread) => void;
  onReply: (thread: ReviewThread, body: string) => void;
  onDelete: (commentId: number) => void;
  onRetryOp: (opId: string) => void;
  onDiscardOp: (opId: string) => void;
}) {
  const [reply, setReply] = useState("");
  const comments = thread.comments.nodes;

  return (
    <div className="border-b border-edge px-5 py-5 last:border-b-0">
      <div className="mb-3 flex items-center gap-2">
        <span className="label">
          {thread.line ? `Line ${thread.line}` : "On the file"}
        </span>
        {thread.isResolved && (
          <span className="text-[0.6875rem] uppercase tracking-wider text-resolved">
            Resolved
          </span>
        )}
        <button
          type="button"
          onClick={() => onResolve(thread)}
          className="label ml-auto text-accent"
        >
          {thread.isResolved ? "Reopen" : "Resolve"}
        </button>
      </div>

      {comments.map((comment, index) => {
        // The first comment carries the quoted passage we injected; replies
        // carry only the identity marker.
        const body =
          index === 0
            ? stripAnchorFromBody(comment.body)
            : stripMarkerFromBody(comment.body);
        const failed = failedOpId(comment.pendingOp);
        const pending = comment.pendingOp && !failed;
        const mine = currentUser && comment.author?.login === currentUser;

        return (
          <div
            key={comment.id}
            className={`mb-4 border-l-2 pl-3.5 last:mb-0 ${
              failed ? "border-danger" : pending ? "border-edge" : "border-thread"
            }`}
          >
            <div className="mb-1 flex items-baseline gap-2 text-xs">
              <span className="font-medium text-ink">
                {comment.author?.login ?? "unknown"}
              </span>
              <span className="text-ink-faint">
                {relativeTime(comment.createdAt)}
              </span>
              {pending && <span className="text-ink-faint">Saving</span>}
              {failed && <span className="text-danger">Not saved</span>}
            </div>
            <p className="note-body text-ink">{body}</p>

            {failed ? (
              <div className="mt-2 flex gap-4 text-xs">
                <button
                  type="button"
                  onClick={() => onRetryOp(failed)}
                  className="text-accent"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => onDiscardOp(failed)}
                  className="text-ink-dim"
                >
                  Discard
                </button>
              </div>
            ) : (
              mine &&
              !pending && (
                <button
                  type="button"
                  onClick={() => onDelete(comment.databaseId)}
                  className="mt-2 text-xs text-ink-faint active:text-danger"
                >
                  Delete
                </button>
              )
            )}
          </div>
        );
      })}

      <div className="mt-4 flex items-center gap-2">
        <input
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          placeholder="Reply"
          className="min-w-0 flex-1 border-b border-edge bg-transparent pb-2 text-ink outline-none placeholder:text-ink-faint focus:border-accent"
        />
        <button
          type="button"
          disabled={!reply.trim()}
          onClick={() => {
            onReply(thread, reply);
            setReply("");
          }}
          className="shrink-0 px-2 pb-2 text-sm text-accent disabled:opacity-25"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/** The notes on one passage, as marginalia rather than a chat thread. */
export function MobileThreadSheet({
  threads,
  currentUser,
  onClose,
  onResolve,
  onReply,
  onDelete,
  onRetryOp,
  onDiscardOp,
}: MobileThreadSheetProps) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close notes"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30"
      />
      <div className="sheet relative max-h-[78%] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-edge bg-panel pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-edge bg-panel px-5 py-3.5">
          <span className="label">
            {threads.length === 1 ? "Note" : `${threads.length} notes`}
          </span>
          <button type="button" onClick={onClose} className="label text-accent">
            Done
          </button>
        </div>
        {threads.map((thread) => (
          <Note
            key={thread.clientKey}
            thread={thread}
            currentUser={currentUser}
            onResolve={onResolve}
            onReply={onReply}
            onDelete={onDelete}
            onRetryOp={onRetryOp}
            onDiscardOp={onDiscardOp}
          />
        ))}
      </div>
    </div>
  );
}
