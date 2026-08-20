import { useCallback, useMemo, useRef, useState } from "react";
import {
  CommentComposer,
  DocumentPane,
  FileTabs,
  GutterPlayButton,
  PlayerPill,
  useSentenceHighlight,
  FindBar,
  MarginRail,
  PRPicker,
  TopBar,
  Toasts,
} from "./components";
import {
  useChapterPlayer,
  useCommentSelection,
  useFileSearch,
  useProseMarks,
  useReviewData,
  useReviewSettings,
  useReviewShortcuts,
  useThreadPresentation,
  useToasts,
} from "./hooks";
import { SignIn } from "./components/SignIn";
import { useAuth } from "./hooks/useAuth";
import { isMobilePlatform } from "./lib/platform";
import { MobileApp } from "./mobile/MobileApp";
// mobile.css imports App.css inside a cascade layer; see the note there.
import "./mobile.css";

const REPO = "SmartPass-Book/book";

/**
 * Auth gate and platform switch. Everything below this point assumes a signed
 * in GitHub client, which is what lets the review UI call the API commands
 * without each of them handling a missing token.
 */
function App() {
  const auth = useAuth();

  if (auth.state.phase !== "signed-in") {
    return (
      <SignIn
        phase={auth.state.phase}
        deviceCode={auth.state.deviceCode}
        error={auth.state.error}
        onSignIn={() => void auth.actions.signIn()}
        onCancel={() => void auth.actions.cancelSignIn()}
        onOpenVerification={() => void auth.actions.openVerification()}
      />
    );
  }

  if (isMobilePlatform()) {
    return (
      <MobileApp
        repo={REPO}
        currentUser={auth.state.status?.user ?? null}
        onSignOut={() => void auth.actions.signOut()}
      />
    );
  }

  return <DesktopApp />;
}

function DesktopApp() {
  const settings = useReviewSettings();
  const notifications = useToasts();
  const [filter, setFilter] = useState("");
  const proseRef = useRef<HTMLDivElement>(null);
  const marks = useProseMarks(proseRef);

  const review = useReviewData({
    repo: REPO,
    unwrapMarks: marks.actions.unwrapMarks,
    pushToast: notifications.actions.pushToast,
    reportError: notifications.actions.reportError,
  });

  const player = useChapterPlayer({
    activeFile: review.state.activeFile,
    fileContent: review.state.fileContent,
    voice: settings.state.voice,
    speed: settings.state.speed,
    onSpeedChange: settings.actions.setSpeed,
  });

  useSentenceHighlight({ proseRef, block: player.readingBlock });

  const selection = useCommentSelection({
    activeFile: review.state.activeFile,
    autoComposer: settings.state.autoComposer,
    postComment: review.actions.postCommentForRange,
    proseRef,
    reportError: notifications.actions.reportError,
    selectedPR: review.state.selectedPR,
  });

  const search = useFileSearch({
    activeFile: review.state.activeFile,
    fileContent: review.state.fileContent,
    proseRef,
  });

  const threadPresentation = useThreadPresentation({
    activeFile: review.state.activeFile,
    currentUser: review.state.currentUser,
    fileContent: review.state.fileContent,
    onlyMine: settings.state.onlyMine,
    repo: REPO,
    proseRef,
    selectedPR: review.state.selectedPR,
    showResolved: settings.state.showResolved,
    threads: review.state.threads,
  });

  const clearHighlightedThread = useCallback(
    () => threadPresentation.actions.setHighlightedThread(null),
    [threadPresentation.actions.setHighlightedThread],
  );

  const shortcuts = useReviewShortcuts({
    clearHighlightedThread,
    clearSelection: selection.actions.clear,
    closeComposer: selection.actions.close,
    closeSearch: search.actions.close,
    composerOpen: selection.state.isOpen,
    highlightedThread: threadPresentation.state.highlightedThread,
    openComposer: selection.actions.open,
    resolveSelection: selection.actions.resolve,
    searchOpen: search.state.isOpen,
    selectionActive: Boolean(selection.state.range),
  });

  const filteredPRs = useMemo(() => {
    const query = filter.toLowerCase();
    return review.state.prs.filter(
      (pullRequest) =>
        !query ||
        pullRequest.title.toLowerCase().includes(query) ||
        String(pullRequest.number).includes(query) ||
        pullRequest.headRefName.toLowerCase().includes(query),
    );
  }, [filter, review.state.prs]);

  return (
    <div className="app">
      <Toasts
        toasts={notifications.state.toasts}
        onDismiss={notifications.actions.dismissToast}
      />
      <PlayerPill audio={player.audio} />
      {review.state.selectedPR ? (
        <>
          <TopBar
            selectedPR={review.state.selectedPR}
            prs={filteredPRs}
            loading={review.state.loading}
            filter={filter}
            switcherOpen={shortcuts.state.switcherOpen}
            refreshing={review.state.refreshing}
            lastRefreshAt={review.state.lastRefreshAt}
            settingsOpen={shortcuts.state.settingsOpen}
            settings={settings.state.settings}
            onFilterChange={setFilter}
            onSelectPR={(number) => {
              void review.actions.openPR(number);
              shortcuts.actions.setSwitcherOpen(false);
            }}
            onSwitcherToggle={() => {
              shortcuts.actions.setSwitcherOpen((open) => {
                const next = !open;
                if (next) void review.actions.refreshPRList();
                return next;
              });
            }}
            onRefresh={() => void review.actions.refreshActivePR()}
            onSettingsToggle={() =>
              shortcuts.actions.setSettingsOpen((open) => !open)
            }
          />
          {search.state.isOpen && (
            <FindBar
              inputRef={search.refs.input}
              query={search.state.query}
              matchCount={search.state.matchCount}
              currentIndex={search.state.currentIndex}
              onQueryChange={search.actions.setQuery}
              onCurrentIndexChange={search.actions.setCurrentIndex}
              onClose={search.actions.close}
            />
          )}
          <div
            className="layout"
            style={{
              ["--threads-width" as any]: `${settings.state.threadsWidth}px`,
            }}
          >
            <main className="main">
              <FileTabs
                files={threadPresentation.state.filesSorted}
                activeFile={review.state.activeFile}
                resolvedCount={threadPresentation.state.resolvedCount}
                showResolved={settings.state.showResolved}
                onlyMine={settings.state.onlyMine}
                otherAuthorCount={threadPresentation.state.otherAuthorCount}
                collaboratorActivity={
                  threadPresentation.state.collaboratorActivity
                }
                onSelectFile={(path) => void review.actions.switchFile(path)}
                onShowResolvedChange={settings.actions.setShowResolved}
                onOnlyMineChange={settings.actions.setOnlyMine}
                onActivateCollaborator={({ thread }) => {
                  const line = thread.line ?? thread.originalLine;
                  threadPresentation.actions.flashThread(thread.clientKey);
                  if (line) threadPresentation.actions.scrollToLine(line);
                }}
              />
              <DocumentPane
                selectedPR={review.state.selectedPR}
                activeFile={review.state.activeFile}
                fileContent={review.state.fileContent}
                components={threadPresentation.state.markdownComponents}
                composerCue={selection.state.cue}
                selectionRange={selection.state.range}
                composerOpen={selection.state.isOpen}
                collaboratorActivity={
                  threadPresentation.state.collaboratorActivity
                }
                collaboratorChipTop={
                  threadPresentation.state.collaboratorChipTop
                }
                proseRef={proseRef}
                proseGridRef={threadPresentation.refs.proseGrid}
                gutter={
                  <GutterPlayButton
                    proseRef={proseRef}
                    contentKey={`${review.state.activeFile ?? ""}:${review.state.fileContent.length}`}
                    onPlayLine={player.playFromLine}
                  />
                }
                onMouseUp={selection.actions.handleMouseUp}
                onOpenComposer={selection.actions.open}
                onFlashCollaborator={() => {
                  const activity =
                    threadPresentation.state.collaboratorActivity;
                  if (activity) {
                    threadPresentation.actions.flashThread(
                      activity.thread.clientKey,
                    );
                  }
                }}
              >
                <MarginRail
                  threadsForFile={threadPresentation.state.threadsForFile}
                  threadAnchors={threadPresentation.state.threadAnchors}
                  anchorMatch={threadPresentation.state.anchorMatch}
                  currentUser={review.state.currentUser}
                  highlightedThread={
                    threadPresentation.state.highlightedThread
                  }
                  proseRef={proseRef}
                  proseGridRef={threadPresentation.refs.proseGrid}
                  registerThreadEl={
                    threadPresentation.refs.registerThreadEl
                  }
                  fileContent={review.state.fileContent}
                  onActivate={(thread) => {
                    if (
                      threadPresentation.state.highlightedThread ===
                      thread.clientKey
                    ) {
                      threadPresentation.actions.setHighlightedThread(null);
                      return;
                    }
                    threadPresentation.actions.flashThread(thread.clientKey);
                  }}
                  onResolve={(thread) =>
                    void review.actions.toggleResolve(thread)
                  }
                  onReply={(thread, body) =>
                    void review.actions.replyTo(thread, body)
                  }
                  onDelete={(commentId) =>
                    void review.actions.deleteComment(commentId)
                  }
                  onRetryOp={review.actions.retryOp}
                  onDiscardOp={review.actions.discardOp}
                />
              </DocumentPane>
              {selection.state.isOpen && selection.state.range && (
                <CommentComposer
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
            </main>
          </div>
        </>
      ) : (
        <PRPicker
          repo={REPO}
          prs={filteredPRs}
          loading={review.state.loading}
          refreshing={review.state.refreshingList}
          filter={filter}
          onFilterChange={setFilter}
          onRefresh={() => void review.actions.refreshPRList()}
          onSelectPR={(number) => void review.actions.openPR(number)}
        />
      )}
    </div>
  );
}

export default App;
