import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Toasts } from "../components";
import {
  useCommentSelection,
  useProseMarks,
  useReviewData,
  useThreadPresentation,
  useToasts,
} from "../hooks";
import type { ReviewThread } from "../types";
import { MobileComposer } from "./MobileComposer";
import { MobileFileSheet } from "./MobileFileSheet";
import { MobileGutter } from "./MobileGutter";
import { MobilePRList } from "./MobilePRList";
import { MobileThreadSheet } from "./MobileThreadSheet";

interface MobileAppProps {
  repo: string;
  currentUser: string | null;
  onSignOut: () => void;
}

/** Inclusive line span a thread covers, used to group notes on one passage. */
function threadSpan(thread: ReviewThread): [number, number] | null {
  const end = thread.line ?? thread.originalLine;
  if (!end) return null;
  const start = thread.startLine ?? end;
  return [Math.min(start, end), Math.max(start, end)];
}

export function MobileApp({ repo, currentUser, onSignOut }: MobileAppProps) {
  const notifications = useToasts();
  const [filter, setFilter] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const proseRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const marks = useProseMarks(proseRef);

  const review = useReviewData({
    repo,
    unwrapMarks: marks.actions.unwrapMarks,
    pushToast: notifications.actions.pushToast,
    reportError: notifications.actions.reportError,
  });

  const selection = useCommentSelection({
    activeFile: review.state.activeFile,
    // The floating action is the explicit open gesture here; auto-opening
    // would fight the iOS selection handles the moment they appear.
    autoComposer: false,
    postComment: review.actions.postCommentForRange,
    proseRef,
    reportError: notifications.actions.reportError,
    selectedPR: review.state.selectedPR,
  });

  const presentation = useThreadPresentation({
    activeFile: review.state.activeFile,
    currentUser: review.state.currentUser,
    fileContent: review.state.fileContent,
    repo,
    proseRef,
    selectedPR: review.state.selectedPR,
    // No resolved-toggle chrome on the phone; resolved notes stay reachable
    // through their gutter tick, drawn in green rather than gold.
    showResolved: true,
    threads: review.state.threads,
  });

  const { handleMouseUp } = selection.actions;
  const composerOpen = selection.state.isOpen;

  // iOS selects text by long-press, which never produces a mouseup, so the
  // capture the desktop hook drives from onMouseUp is driven from
  // selectionchange instead.
  useEffect(() => {
    if (composerOpen) return;
    const onSelectionChange = () => {
      const current = window.getSelection();
      const active =
        !!current &&
        !current.isCollapsed &&
        current.rangeCount > 0 &&
        !!proseRef.current?.contains(
          current.getRangeAt(0).commonAncestorContainer,
        );
      setHasSelection(active);
      if (active) handleMouseUp();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, [composerOpen, handleMouseUp]);

  useEffect(() => {
    if (composerOpen) setHasSelection(false);
  }, [composerOpen]);

  const filteredPRs = useMemo(() => {
    const query = filter.toLowerCase();
    return review.state.prs.filter(
      (pr) =>
        !query ||
        pr.title.toLowerCase().includes(query) ||
        String(pr.number).includes(query) ||
        pr.headRefName.toLowerCase().includes(query),
    );
  }, [filter, review.state.prs]);

  // Tapping a paragraph or a gutter tick sets the highlighted thread; surface
  // every note on that same passage so a back-and-forth opens as one
  // conversation rather than one comment at a time.
  const highlighted = presentation.state.highlightedThread;
  const sheetThreads = useMemo(() => {
    if (!highlighted) return [];
    const threads = presentation.state.threadsForFile;
    const target = threads.find((thread) => thread.clientKey === highlighted);
    if (!target) return [];
    const span = threadSpan(target);
    if (!span) return [target];
    return threads.filter((thread) => {
      const other = threadSpan(thread);
      return other ? other[0] <= span[1] && other[1] >= span[0] : false;
    });
  }, [highlighted, presentation.state.threadsForFile]);

  const closeThreadSheet = useCallback(
    () => presentation.actions.setHighlightedThread(null),
    [presentation.actions],
  );

  const openThreadFromGutter = useCallback(
    (thread: ReviewThread) => {
      presentation.actions.flashThread(thread.clientKey);
    },
    [presentation.actions],
  );

  if (!review.state.selectedPR) {
    return (
      <div className="mobile-root h-full">
        <Toasts
          toasts={notifications.state.toasts}
          onDismiss={notifications.actions.dismissToast}
        />
        <MobilePRList
          repo={repo}
          prs={filteredPRs}
          loading={review.state.loading}
          refreshing={review.state.refreshingList}
          filter={filter}
          currentUser={currentUser}
          onFilterChange={setFilter}
          onRefresh={() => void review.actions.refreshPRList()}
          onSelectPR={(number) => void review.actions.openPR(number)}
          onSignOut={onSignOut}
        />
      </div>
    );
  }

  const pr = review.state.selectedPR;
  const activeName =
    review.state.activeFile?.split("/").pop() ?? review.state.activeFile ?? "";
  const openNotes = presentation.state.threadsForFile.filter(
    (thread) => !thread.isResolved,
  ).length;
  // "No notes" on a file carrying a dozen settled ones reads as "nothing
  // happened here", which is the opposite of the truth. Fall back to the
  // resolved count so a fully-reviewed file says so.
  const notesLabel =
    openNotes > 0
      ? `${openNotes} ${openNotes === 1 ? "note" : "notes"}`
      : presentation.state.resolvedCount > 0
        ? `${presentation.state.resolvedCount} resolved`
        : "no notes";

  return (
    <div className="mobile-root flex h-full flex-col">
      <Toasts
        toasts={notifications.state.toasts}
        onDismiss={notifications.actions.dismissToast}
      />

      {/* Running head. One line, so the text starts as high on the screen as
          it can - this is a reading app before it is a review app. */}
      {/* Added to the inset, not maxed against it - see the note in
          MobilePRList. The top inset is status-bar clearance, so the running
          head needs its own padding below it; the bottom insets elsewhere are
          home-indicator clearance, where max() is the right call. */}
      <header className="shrink-0 border-b border-edge px-4 pb-2.5 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Back to drafts"
            onClick={review.actions.closePR}
            className="-ml-1 shrink-0 px-2 py-1 text-xl leading-none text-accent active:opacity-50"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setFilesOpen(true)}
            className="min-w-0 flex-1 px-1 text-left active:opacity-60"
          >
            <span className="block truncate text-[0.9375rem] leading-tight text-ink">
              {activeName}
            </span>
            <span className="label mt-0.5 block truncate">
              {pr.title} · {notesLabel}
            </span>
          </button>
          <button
            type="button"
            aria-label="Refresh"
            onClick={() => void review.actions.refreshActivePR()}
            disabled={review.state.refreshing}
            className="shrink-0 px-2 py-1 text-base text-accent disabled:opacity-30 active:opacity-50"
          >
            {review.state.refreshing ? "···" : "↻"}
          </button>
        </div>
      </header>

      <main
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="relative mx-auto max-w-[42rem] pl-6 pr-5 py-5">
          <MobileGutter
            scrollRef={scrollRef}
            proseRef={proseRef}
            threads={presentation.state.threadsForFile}
            highlighted={highlighted}
            contentKey={`${review.state.activeFile ?? ""}:${review.state.fileContent.length}`}
            onSelectThread={openThreadFromGutter}
          />
          <div ref={proseRef} className="mobile-prose pb-28">
            {review.state.fileContent ? (
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={presentation.state.markdownComponents}
              >
                {review.state.fileContent}
              </Markdown>
            ) : (
              <p className="text-sm text-ink-faint">Loading...</p>
            )}
          </div>
        </div>
      </main>

      {hasSelection && selection.state.range && !composerOpen && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={selection.actions.open}
            className="pointer-events-auto rounded-full bg-ink px-7 py-3.5 text-sm font-medium tracking-wide text-paper shadow-xl active:opacity-80"
          >
            Add note
          </button>
        </div>
      )}

      {composerOpen && selection.state.range && (
        <MobileComposer
          range={selection.state.range}
          anchor={selection.state.anchor}
          body={selection.state.body}
          selectionInDiff={selection.state.inDiff}
          submitting={review.state.loading}
          onBodyChange={selection.actions.setBody}
          onCancel={selection.actions.close}
          onSubmit={() => void selection.actions.submit()}
        />
      )}

      {filesOpen && (
        <MobileFileSheet
          files={presentation.state.filesSorted}
          activeFile={review.state.activeFile}
          prTitle={pr.title}
          onSelectFile={(path) => void review.actions.switchFile(path)}
          onClose={() => setFilesOpen(false)}
        />
      )}

      {sheetThreads.length > 0 && (
        <MobileThreadSheet
          threads={sheetThreads}
          currentUser={review.state.currentUser}
          onClose={closeThreadSheet}
          onResolve={(thread) => void review.actions.toggleResolve(thread)}
          onReply={(thread, body) => void review.actions.replyTo(thread, body)}
          onDelete={(commentId) => void review.actions.deleteComment(commentId)}
          onRetryOp={review.actions.retryOp}
          onDiscardOp={review.actions.discardOp}
        />
      )}
    </div>
  );
}
