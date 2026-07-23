import type { RefObject } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import commentIconUrl from "../assets/icons/comment.svg";
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
              <span
                className="composer-cue-icon"
                style={{
                  maskImage: `url(${commentIconUrl})`,
                  WebkitMaskImage: `url(${commentIconUrl})`,
                }}
                aria-hidden="true"
              />
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
