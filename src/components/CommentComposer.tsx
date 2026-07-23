import type { Anchor } from "../lib/anchors";
import { truncate } from "../lib/reviewFormatting";
import type { LineRange } from "./reviewTypes";

interface CommentComposerProps {
  range: LineRange;
  anchor: Anchor | null;
  body: string;
  selectionInDiff: boolean;
  submitting: boolean;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function CommentComposer({
  range,
  anchor,
  body,
  selectionInDiff,
  submitting,
  onBodyChange,
  onCancel,
  onSubmit,
}: CommentComposerProps) {
  return (
    <div className="composer">
      <div className="composer-header">
        {anchor ? (
          <>
            Commenting on <span className="anchor-pill">{truncate(anchor.exact, 60)}</span>{" "}
            <span
              className="composer-line"
              title={
                selectionInDiff
                  ? "This passage is in the PR diff, so the comment attaches to the line"
                  : "This passage is outside the PR diff, so the comment attaches to the file and is placed by its anchor text"
              }
            >
              {selectionInDiff ? `L${range.end}` : "file"}
            </span>
          </>
        ) : (
          <>
            Comment on lines {range.start}
            {range.end !== range.start ? `-${range.end}` : ""}
          </>
        )}
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(event) => onBodyChange(event.target.value)}
        placeholder="Leave a comment"
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            onSubmit();
          }
          if (event.key === "Escape") onCancel();
        }}
      />
      <div className="composer-actions">
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          onClick={onSubmit}
          disabled={!body.trim() || submitting}
        >
          Comment
          <kbd className="kbd-inline" aria-label="Enter">
            ⏎
          </kbd>
        </button>
      </div>
    </div>
  );
}
