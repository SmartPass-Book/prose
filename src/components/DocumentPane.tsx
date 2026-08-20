import type { ReactNode, RefObject } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import commentIconUrl from "../assets/icons/comment.svg";
import { activityFreshness, relativeTime } from "../lib/reviewFormatting";
import type { PR } from "../types";
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
  proseRef: RefObject<HTMLDivElement | null>;
  /// Rendered inside `.prose`, which is the positioning context the gutter
  /// play button measures against.
  gutter?: ReactNode;
  proseGridRef: RefObject<HTMLDivElement | null>;
  onMouseUp: () => void;
  onOpenComposer: () => void;
  onFlashCollaborator: () => void;
  children: ReactNode;
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
  proseRef,
  proseGridRef,
  gutter,
  onMouseUp,
  onOpenComposer,
  onFlashCollaborator,
  children,
}: DocumentPaneProps) {
  return (
    <div className="prose-scroll">
      <div className="prose-grid" ref={proseGridRef}>
        <div className="prose" ref={proseRef} onMouseUp={onMouseUp}>
          {gutter}
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
              onClick={onFlashCollaborator}
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
        {children}
      </div>
    </div>
  );
}
