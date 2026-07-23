import { useEffect, useState } from "react";

interface UseReviewShortcutsOptions {
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
      if (event.key === "c" && resolveSelection()) {
        event.preventDefault();
        openComposer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
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
    settingsOpen,
    setSettingsOpen,
    setSwitcherOpen,
    switcherOpen,
  };
}
