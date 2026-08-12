import { useEffect, useRef } from "react";
import type { Anchor } from "../lib/anchors";
import type { LineRange } from "../components/reviewTypes";

interface MobileComposerProps {
  range: LineRange;
  anchor: Anchor | null;
  body: string;
  selectionInDiff: boolean;
  submitting: boolean;
  onBodyChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

/**
 * Writing surface for a new note.
 *
 * The quoted passage sits above the field so the thing being annotated stays
 * on screen while the keyboard is up - on a phone the passage would otherwise
 * be pushed out of view by the keyboard exactly when you need it.
 */
export function MobileComposer({
  range,
  anchor,
  body,
  selectionInDiff,
  submitting,
  onBodyChange,
  onCancel,
  onSubmit,
}: MobileComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const quoted = anchor?.exact.replace(/\s+/g, " ").trim();

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Discard note"
        onClick={onCancel}
        className="absolute inset-0 bg-ink/30"
      />
      {/* The `composer` class is load-bearing, not styling: useCommentSelection
          dismisses the composer on any pointer-down that isn't inside
          `.composer`. Without it, pressing Add note dismissed the sheet before
          the click could fire and the note was silently dropped. */}
      <div className="composer sheet relative rounded-t-2xl border-t border-edge bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <span className="label">
            {range.start === range.end
              ? `Line ${range.start}`
              : `Lines ${range.start}-${range.end}`}
          </span>
          {!selectionInDiff && (
            // GitHub only accepts a line-anchored comment inside the PR diff,
            // so anything else posts at file level. Saying so up front beats
            // letting it look like a failure afterwards.
            <span className="text-xs text-ink-faint">Note on the file</span>
          )}
        </div>

        {quoted && (
          <blockquote className="note-quote mb-4 max-h-[4.5rem] overflow-y-auto">
            {quoted}
          </blockquote>
        )}

        <textarea
          ref={inputRef}
          value={body}
          onChange={(event) => onBodyChange(event.target.value)}
          rows={4}
          placeholder="What should change here?"
          className="w-full resize-none rounded-lg border border-edge bg-paper px-3.5 py-3 leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-accent"
        />

        <div className="mt-3.5 flex items-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-2 py-3 text-sm text-ink-dim active:opacity-60"
          >
            Discard
          </button>
          <button
            type="button"
            disabled={!body.trim() || submitting}
            onClick={onSubmit}
            className="ml-auto rounded-lg bg-ink px-7 py-3 text-sm font-medium text-paper disabled:opacity-25 active:opacity-80"
          >
            {submitting ? "Saving" : "Add note"}
          </button>
        </div>
      </div>
    </div>
  );
}
