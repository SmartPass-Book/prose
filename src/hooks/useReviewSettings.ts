import { useEffect, useMemo, useState } from "react";
import type { ToggleSetting } from "../components";

const SHOW_RESOLVED_KEY = "nr.showResolved";
const THREADS_WIDTH_KEY = "nr.threadsWidth";
const AUTO_COMPOSER_KEY = "nr.autoComposer";
const DEFAULT_THREADS_WIDTH = 360;
const MIN_THREADS_WIDTH = 240;
const MAX_THREADS_WIDTH = 720;

export function useReviewSettings() {
  const [showResolved, setShowResolved] = useState(
    () => localStorage.getItem(SHOW_RESOLVED_KEY) === "1",
  );
  const [autoComposer, setAutoComposer] = useState(
    () => localStorage.getItem(AUTO_COMPOSER_KEY) !== "0",
  );
  const [threadsWidth] = useState(() => {
    const stored = parseInt(localStorage.getItem(THREADS_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(stored) &&
      stored >= MIN_THREADS_WIDTH &&
      stored <= MAX_THREADS_WIDTH
      ? stored
      : DEFAULT_THREADS_WIDTH;
  });

  useEffect(() => {
    localStorage.setItem(SHOW_RESOLVED_KEY, showResolved ? "1" : "0");
  }, [showResolved]);

  useEffect(() => {
    localStorage.setItem(AUTO_COMPOSER_KEY, autoComposer ? "1" : "0");
  }, [autoComposer]);

  useEffect(() => {
    localStorage.setItem(THREADS_WIDTH_KEY, String(threadsWidth));
  }, [threadsWidth]);

  const settings = useMemo<ToggleSetting[]>(
    () => [
      {
        id: "autoComposer",
        label: "Comment on selection",
        description:
          "Open the comment box as soon as you select text. When off, selecting shows a cue button you can click, or press c.",
        value: autoComposer,
        onChange: setAutoComposer,
      },
      {
        id: "showResolved",
        label: "Show resolved threads",
        description: "Keep resolved comments visible in the margin instead of hiding them.",
        value: showResolved,
        onChange: setShowResolved,
      },
    ],
    [autoComposer, showResolved],
  );

  return {
    state: {
      autoComposer,
      settings,
      showResolved,
      threadsWidth,
    },
    actions: { setShowResolved },
  };
}
