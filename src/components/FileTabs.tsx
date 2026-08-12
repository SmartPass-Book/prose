import type { CollaboratorActivity, FileWithThreads } from "./reviewTypes";
import { activityFreshness, relativeTime } from "../lib/reviewFormatting";

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span className="check" aria-hidden="true">
      {checked ? (
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path
            fill="currentColor"
            d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"
          />
        </svg>
      ) : null}
    </span>
  );
}

interface FileTabsProps {
  files: FileWithThreads[];
  activeFile: string | null;
  resolvedCount: number;
  showResolved: boolean;
  onlyMine: boolean;
  /** Threads on this file written only by other people. */
  otherAuthorCount: number;
  collaboratorActivity: CollaboratorActivity | null;
  onSelectFile: (path: string) => void;
  onShowResolvedChange: (show: boolean) => void;
  onOnlyMineChange: (only: boolean) => void;
  onActivateCollaborator: (activity: CollaboratorActivity) => void;
}

export function FileTabs({
  files,
  activeFile,
  resolvedCount,
  showResolved,
  onlyMine,
  otherAuthorCount,
  collaboratorActivity,
  onSelectFile,
  onShowResolvedChange,
  onOnlyMineChange,
  onActivateCollaborator,
}: FileTabsProps) {
  return (
    <div className="file-tabs">
      <div className="file-tabs-list">
        {files.map((file) => (
          <button
            key={file.path}
            className={file.path === activeFile ? "active" : ""}
            onClick={() => onSelectFile(file.path)}
            title={file.path}
          >
            <span>{file.path.split("/").pop()}</span>
            {file.unresolved > 0 && (
              <span
                className="file-badge"
                title={`${file.unresolved} unresolved`}
              >
                {file.unresolved}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="file-tabs-aside">
        {resolvedCount > 0 && (
          <button
            className={`toggle-chip ${showResolved ? "on" : ""}`}
            onClick={() => onShowResolvedChange(!showResolved)}
            title={showResolved ? "Hide resolved threads" : "Show resolved threads"}
          >
            <CheckBox checked={showResolved} />
            Show resolved ({resolvedCount})
          </button>
        )}
        {/* Stays mounted while the filter is on even with nothing left to
            hide, so the chip that emptied the margin is also the way back. */}
        {(onlyMine || otherAuthorCount > 0) && (
          <button
            className={`toggle-chip ${onlyMine ? "on" : ""}`}
            onClick={() => onOnlyMineChange(!onlyMine)}
            title={
              onlyMine
                ? "Show everyone's comments"
                : "Hide comments from other people"
            }
          >
            <CheckBox checked={onlyMine} />
            Only mine{otherAuthorCount > 0 ? ` (${otherAuthorCount})` : ""}
          </button>
        )}
        {collaboratorActivity && (
          <button
            className={`activity-chip ${activityFreshness(
              collaboratorActivity.comment.createdAt,
            )}`}
            onClick={() => onActivateCollaborator(collaboratorActivity)}
            title={`Latest from ${collaboratorActivity.comment.author.login}`}
          >
            <span className="avatar">
              {collaboratorActivity.comment.author.login[0]?.toUpperCase()}
            </span>
            {collaboratorActivity.comment.author.login} · L
            {collaboratorActivity.thread.line ??
              collaboratorActivity.thread.originalLine}{" "}
            · {relativeTime(collaboratorActivity.comment.createdAt)}
          </button>
        )}
      </div>
    </div>
  );
}
