import { useEffect, useState } from "react";

interface UseReviewShortcutsOptions {
  /// The audio player's transport, live only while a chapter is loaded.
  audio: {
    active: boolean;
    toggle: () => void;
    next: () => void;
    previous: () => void;
  };
  /// Pause and select the sentence being read so `c` anchors the composer to
  /// it. Returns false when playback has nothing selectable, in which case `c`
  /// falls through to its normal text-selection behaviour.
  captureSpokenSentence: () => boolean;
  clearHighlightedThread: () => void;
  clearSelection: () => void;
  closeComposer: () => void;
  closeSearch: () => void;
  composerOpen: boolean;
  highlightedThread: string | null;
  openComposer: () => void;
  resolveSelection: () => unknown;
  searchOpen: boolean;
  selectionActive: boolean;
}

export function useReviewShortcuts({
  audio,
  captureSpokenSentence,
  clearHighlightedThread,
  clearSelection,
  closeComposer,
  closeSearch,
  composerOpen,
  highlightedThread,
  openComposer,
  resolveSelection,
  searchOpen,
  selectionActive,
}: UseReviewShortcutsOptions) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!switcherOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        !target.closest(".pr-switcher") &&
        !target.closest(".pr-switcher-menu")
      ) {
        setSwitcherOpen(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [switcherOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && !target.closest(".settings-wrap")) setSettingsOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [settingsOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (event.key === "Escape") {
        if (searchOpen) closeSearch();
        else if (switcherOpen) setSwitcherOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (composerOpen) closeComposer();
        else if (selectionActive) clearSelection();
        else if (highlightedThread) clearHighlightedThread();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || inField || composerOpen) {
        return;
      }
      // During playback, `c` comments on the sentence that just sounded wrong.
      // It synthesizes the selection the composer normally reads from a drag,
      // so everything downstream is unchanged.
      if (event.key === "c" && audio.active && captureSpokenSentence()) {
        if (resolveSelection()) {
          event.preventDefault();
          openComposer();
          return;
        }
      }
      if (event.key === "c" && resolveSelection()) {
        event.preventDefault();
        openComposer();
        return;
      }
      if (!audio.active) return;
      // Transport. Space and the arrows are unbound elsewhere, and all three
      // are already gated above on not being in a field or composer.
      if (event.key === " ") {
        event.preventDefault();
        audio.toggle();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        audio.previous();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        audio.next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    audio,
    captureSpokenSentence,
    clearHighlightedThread,
    clearSelection,
    closeComposer,
    closeSearch,
    composerOpen,
    highlightedThread,
    openComposer,
    resolveSelection,
    searchOpen,
    selectionActive,
    settingsOpen,
    switcherOpen,
  ]);

  return {
    state: { settingsOpen, switcherOpen },
    actions: { setSettingsOpen, setSwitcherOpen },
  };
}
