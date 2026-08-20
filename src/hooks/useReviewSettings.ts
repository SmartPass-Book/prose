import { useEffect, useMemo, useState } from "react";
import type { ToggleSetting } from "../components";
import { SPEEDS, type Speed } from "./useChapterAudio";

/// Matches `fetch::DEFAULT_VOICE` in the backend. Kept as a literal rather than
/// fetched, so the first render has a voice without waiting on IPC; the picker
/// gets the real list from `tts_voices`.
const DEFAULT_VOICE = "af_heart";

const SHOW_RESOLVED_KEY = "nr.showResolved";
const THREADS_WIDTH_KEY = "nr.threadsWidth";
const AUTO_COMPOSER_KEY = "nr.autoComposer";
const ONLY_MINE_KEY = "nr.onlyMine";
const VOICE_KEY = "nr.ttsVoice";
const SPEED_KEY = "nr.ttsSpeed";
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
  const [onlyMine, setOnlyMine] = useState(
    () => localStorage.getItem(ONLY_MINE_KEY) === "1",
  );
  // Voice and speed persist across restarts; the playhead deliberately does
  // not. A chapter is short enough to restart, and a remembered position that
  // no longer matches an edited file is worse than none.
  const [voice, setVoice] = useState(
    () => localStorage.getItem(VOICE_KEY) ?? DEFAULT_VOICE,
  );
  const [speed, setSpeed] = useState<Speed>(() => {
    const stored = Number(localStorage.getItem(SPEED_KEY));
    return (SPEEDS as readonly number[]).includes(stored) ? (stored as Speed) : 1;
  });

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
    localStorage.setItem(ONLY_MINE_KEY, onlyMine ? "1" : "0");
  }, [onlyMine]);

  useEffect(() => {
    localStorage.setItem(THREADS_WIDTH_KEY, String(threadsWidth));
  }, [threadsWidth]);

  useEffect(() => {
    localStorage.setItem(VOICE_KEY, voice);
  }, [voice]);

  useEffect(() => {
    localStorage.setItem(SPEED_KEY, String(speed));
  }, [speed]);

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
      {
        id: "onlyMine",
        label: "Only my comments",
        description:
          "Hide threads you haven't written in, so the margin holds your own review pass and nothing else.",
        value: onlyMine,
        onChange: setOnlyMine,
      },
    ],
    [autoComposer, onlyMine, showResolved],
  );

  return {
    state: {
      autoComposer,
      onlyMine,
      settings,
      showResolved,
      speed,
      threadsWidth,
      voice,
    },
    actions: { setOnlyMine, setShowResolved, setSpeed, setVoice },
  };
}
