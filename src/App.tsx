import { useMemo, useRef, useState, useCallback } from "react";
import {
  CommentComposer,
  DocumentPane,
  FileTabs,
  FindBar,
  PRPicker,
  TopBar,
  Toasts,
} from "./components";
import {
  useCommentSelection,
  useFileSearch,
  useProseMarks,
  useReviewData,
  useReviewSettings,
  useReviewShortcuts,
  useThreadPresentation,
  useToasts,
} from "./hooks";
import "./App.css";

// The repo is hard-coded for now: this app is a single-team review tool.
// If we ever ship to multiple teams, lift this back to user-configurable.
const REPO = "SmartPass-Book/book";

function App() {
  const repo = REPO;
  const {
    autoComposer,
    settings: appSettings,
    showResolved,
    setShowResolved,
    threadsWidth,
  } = useReviewSettings();
  const { toasts, dismissToast, pushToast, reportError } = useToasts();
  const [filter, setFilter] = useState("");
  const proseRef = useRef<HTMLDivElement>(null);
  const { unwrapMarks } = useProseMarks(proseRef);

  const {
    activeFile,
    currentUser,
    deleteComment,
    discardOp,
    fileContent,
    lastRefreshAt,
    loading,
    openPR,
    postCommentForRange,
    prs,
    refreshing,
    refreshActivePR,
    refreshPRList,
    replyTo,
    retryOp,
    selectedPR,
    switchFile,
    threads,
    toggleResolve,
  } = useReviewData({ repo, unwrapMarks, pushToast, reportError });

  const {
    clearSelection,
    closeComposer,
    composerBody,
    composerCue,
    composerOpen,
    onMouseUp,
    openComposer,
    resolveSelection,
    selectionAnchor: selAnchor,
    selectionInDiff,
    selectionRange: selRange,
    setComposerBody,
    submitComment,
  } = useCommentSelection({
    activeFile,
    autoComposer,
    postComment: postCommentForRange,
    proseRef,
    reportError,
    selectedPR,
  });

  const {
    closeSearch,
    searchCurrentIndex,
    searchInputRef,
    searchMatchCount,
    searchOpen,
    searchQuery,
    setSearchCurrentIndex,
    setSearchQuery,
  } = useFileSearch({ activeFile, fileContent, proseRef });

  const {
    anchorMatch,
    collaboratorActivity,
    collaboratorChipTop,
    filesSorted,
    flashThread,
    highlightedThread,
    markdownComponents: mdComponents,
    proseGridRef,
    registerThreadEl,
    resolvedCount,
    scrollToLine,
    setHighlightedThread,
    threadAnchors,
    threadsForFile,
  } = useThreadPresentation({
    activeFile,
    currentUser,
    fileContent,
    proseRef,
    selectedPR,
    showResolved,
    threads,
  });
  const clearHighlightedThread = useCallback(
    () => setHighlightedThread(null),
    [setHighlightedThread],
  );

  const { settingsOpen, setSettingsOpen, setSwitcherOpen, switcherOpen } =
    useReviewShortcuts({
      clearHighlightedThread,
      clearSelection,
      closeComposer,
      closeSearch,
      composerOpen,
      highlightedThread,
      openComposer,
      resolveSelection,
      searchOpen,
      selectionActive: Boolean(selRange),
    });

  const filteredPRs = useMemo(() => {
    const f = filter.toLowerCase();
    return prs.filter(
      (p) =>
        !f ||
        p.title.toLowerCase().includes(f) ||
        String(p.number).includes(f) ||
        p.headRefName.toLowerCase().includes(f),
    );
  }, [prs, filter]);

  return (
    <div className="app">
      <Toasts toasts={toasts} onDismiss={dismissToast} />
      {selectedPR ? (
        <>
          <TopBar
            selectedPR={selectedPR}
            prs={filteredPRs}
            loading={loading}
            filter={filter}
            switcherOpen={switcherOpen}
            refreshing={refreshing}
            lastRefreshAt={lastRefreshAt}
            settingsOpen={settingsOpen}
            settings={appSettings}
            onFilterChange={setFilter}
            onSelectPR={(number) => {
              void openPR(number);
              setSwitcherOpen(false);
            }}
            onSwitcherToggle={() => {
              setSwitcherOpen((open) => {
                const next = !open;
                if (next) void refreshPRList();
                return next;
              });
            }}
            onRefresh={() => void refreshActivePR()}
            onSettingsToggle={() => setSettingsOpen((open) => !open)}
          />
          {searchOpen && (
            <FindBar
              inputRef={searchInputRef}
              query={searchQuery}
              matchCount={searchMatchCount}
              currentIndex={searchCurrentIndex}
              onQueryChange={setSearchQuery}
              onCurrentIndexChange={(updater) => setSearchCurrentIndex(updater)}
              onClose={closeSearch}
            />
          )}
          <div
            className="layout"
            style={{ ["--threads-width" as any]: `${threadsWidth}px` }}
          >
            <main className="main">
              <FileTabs
                files={filesSorted}
                activeFile={activeFile}
                resolvedCount={resolvedCount}
                showResolved={showResolved}
                collaboratorActivity={collaboratorActivity}
                onSelectFile={(path) => void switchFile(path)}
                onShowResolvedChange={setShowResolved}
                onActivateCollaborator={({ thread }) => {
                  const line = thread.line ?? thread.originalLine;
                  flashThread(thread.clientKey);
                  if (line) scrollToLine(line);
                }}
              />
              <DocumentPane
                selectedPR={selectedPR}
                activeFile={activeFile}
                fileContent={fileContent}
                components={mdComponents}
                composerCue={composerCue}
                selectionRange={selRange}
                composerOpen={composerOpen}
                collaboratorActivity={collaboratorActivity}
                collaboratorChipTop={collaboratorChipTop}
                threadsForFile={threadsForFile}
                threadAnchors={threadAnchors}
                anchorMatch={anchorMatch}
                currentUser={currentUser}
                highlightedThread={highlightedThread}
                proseRef={proseRef}
                proseGridRef={proseGridRef}
                registerThreadEl={registerThreadEl}
                onMouseUp={onMouseUp}
                onOpenComposer={openComposer}
                onFlashThread={(thread) => flashThread(thread.clientKey)}
                onActivateThread={(thread) => {
                  if (highlightedThread === thread.clientKey) {
                    setHighlightedThread(null);
                    return;
                  }
                  flashThread(thread.clientKey);
                }}
                onResolveThread={(thread) => void toggleResolve(thread)}
                onReply={(thread, body) => void replyTo(thread, body)}
                onDeleteComment={(commentId) => void deleteComment(commentId)}
                onRetryOp={retryOp}
                onDiscardOp={discardOp}
              />
              {composerOpen && selRange && (
                <CommentComposer
                  range={selRange}
                  anchor={selAnchor}
                  body={composerBody}
                  selectionInDiff={selectionInDiff}
                  submitting={loading}
                  onBodyChange={setComposerBody}
                  onCancel={closeComposer}
                  onSubmit={() => void submitComment()}
                />
              )}
            </main>
          </div>
        </>
      ) : (
        <PRPicker
          repo={repo}
          prs={filteredPRs}
          loading={loading}
          filter={filter}
          onFilterChange={setFilter}
          onSelectPR={(number) => void openPR(number)}
        />
      )}
    </div>
  );
}

export default App;
