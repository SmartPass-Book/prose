import type { RefObject } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Anchor, AnchorMatch } from "../lib/anchors";
import { activityFreshness, relativeTime } from "../lib/reviewFormatting";
import type { PR, ReviewThread } from "../types";
import { MarginRail } from "./MarginRail";
import type { CollaboratorActivity, LineRange } from "./reviewTypes";

interface DocumentPaneProps {
  selectedPR: PR;
  activeFile: string | null;
  fileContent: string;
  components: Components;
  composerCue: { top: number; left: number } | null;
  selectionRange: LineRange | null;
  composerOpen: boolean;
  collaboratorActivity: CollaboratorActivity | null;
  collaboratorChipTop: number | null;
  threadsForFile: ReviewThread[];
  threadAnchors: Map<string, Anchor>;
  anchorMatch: Map<string, AnchorMatch>;
  currentUser: string | null;
  highlightedThread: string | null;
  proseRef: RefObject<HTMLDivElement | null>;
  proseGridRef: RefObject<HTMLDivElement | null>;
  registerThreadEl: (id: string, element: HTMLElement | null) => void;
  onMouseUp: () => void;
  onOpenComposer: () => void;
  onFlashThread: (thread: ReviewThread) => void;
  onActivateThread: (thread: ReviewThread) => void;
  onResolveThread: (thread: ReviewThread) => void;
  onReply: (thread: ReviewThread, body: string) => void;
  onDeleteComment: (commentId: number) => void;
  onRetryOp: (opId: string) => void;
  onDiscardOp: (opId: string) => void;
}

export function DocumentPane({
  selectedPR,
  activeFile,
  fileContent,
  components,
  composerCue,
  selectionRange,
  composerOpen,
  collaboratorActivity,
  collaboratorChipTop,
  threadsForFile,
  threadAnchors,
  anchorMatch,
  currentUser,
  highlightedThread,
  proseRef,
  proseGridRef,
  registerThreadEl,
  onMouseUp,
  onOpenComposer,
  onFlashThread,
  onActivateThread,
  onResolveThread,
  onReply,
  onDeleteComment,
  onRetryOp,
  onDiscardOp,
}: DocumentPaneProps) {
  return (
    <div className="prose-scroll">
      <div className="prose-grid" ref={proseGridRef}>
        <div className="prose" ref={proseRef} onMouseUp={onMouseUp}>
          {composerCue && selectionRange && !composerOpen && (
            <button
              className="composer-cue"
              style={{ top: composerCue.top, left: composerCue.left }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onOpenComposer();
              }}
              title="Comment on selection (c)"
              aria-label="Comment on selection"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M2.75 2h10.5A1.75 1.75 0 0 1 15 3.75v6.5A1.75 1.75 0 0 1 13.25 12H8.06l-2.97 2.97a.75.75 0 0 1-1.28-.53V12H2.75A1.75 1.75 0 0 1 1 10.25v-6.5A1.75 1.75 0 0 1 2.75 2z"
                />
              </svg>
            </button>
          )}
          {collaboratorChipTop !== null && collaboratorActivity && (
            <button
              className={`gutter-chip ${activityFreshness(
                collaboratorActivity.comment.createdAt,
              )}`}
              style={{ top: collaboratorChipTop }}
              onClick={() => onFlashThread(collaboratorActivity.thread)}
              title={`${collaboratorActivity.comment.author.login} · ${relativeTime(
                collaboratorActivity.comment.createdAt,
              )}`}
            >
              <span className="avatar">
                {collaboratorActivity.comment.author.login[0]?.toUpperCase()}
              </span>
            </button>
          )}
          {fileContent ? (
            <ReactMarkdown
              key={`${selectedPR.headRefOid}:${activeFile ?? ""}`}
              remarkPlugins={[remarkGfm]}
              components={components}
            >
              {fileContent}
            </ReactMarkdown>
          ) : (
            <div className="empty-prose">Select a file</div>
          )}
        </div>
        <MarginRail
          threadsForFile={threadsForFile}
          threadAnchors={threadAnchors}
          anchorMatch={anchorMatch}
          currentUser={currentUser}
          highlightedThread={highlightedThread}
          proseRef={proseRef}
          proseGridRef={proseGridRef}
          registerThreadEl={registerThreadEl}
          fileContent={fileContent}
          onActivate={onActivateThread}
          onResolve={onResolveThread}
          onReply={onReply}
          onDelete={onDeleteComment}
          onRetryOp={onRetryOp}
          onDiscardOp={onDiscardOp}
        />
      </div>
    </div>
  );
}
