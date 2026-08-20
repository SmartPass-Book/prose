import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SpeakableDoc } from "../lib/speech";

/// Playback of a chapter, one sentence at a time.
///
/// The queue lives here rather than in Rust on purpose. Skipping backwards is
/// most of what proofreading by ear consists of, and a backend that owned the
/// queue would have to be told to throw it away on every skip. Rust renders one
/// sentence when asked; this decides which sentence and when.

export type PlayerStatus =
  | "idle"
  /// Downloading or loading the model. Only ever seen on a first play.
  | "preparing"
  /// The model is up but the next sentence has not finished rendering.
  | "buffering"
  | "playing"
  | "paused"
  | "error";

export interface DownloadProgress {
  asset: string;
  received: number;
  total: number;
  step: number;
  steps: number;
}

/// How far ahead to render. Three sentences is enough that playback does not
/// stall at a paragraph boundary on a machine that renders at 8x real time,
/// and few enough that skipping does not throw away much work.
const LOOKAHEAD = 3;

export const SPEEDS = [1, 1.25, 1.5, 1.75, 2] as const;
export type Speed = (typeof SPEEDS)[number];

export interface ChapterAudio {
  status: PlayerStatus;
  /// Index into `doc.utterances`, or null when nothing is loaded.
  current: number | null;
  speed: Speed;
  progress: DownloadProgress | null;
  error: string | null;
  playFrom: (utterance: number) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  stop: () => void;
  cycleSpeed: (reverse?: boolean) => void;
}

/// Speed is owned by the caller rather than by this hook: it persists across
/// restarts, which is a settings concern, and the pill is not the only thing
/// that will want to set it.
export function useChapterAudio(
  doc: SpeakableDoc | null,
  voice: string,
  speed: Speed,
  onSpeedChange: (speed: Speed) => void,
): ChapterAudio {
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [current, setCurrent] = useState<number | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  /// Rendered chunks, keyed by utterance index. Cleared when the document
  /// changes, since the indices mean something different then.
  const cacheRef = useRef(new Map<number, string>());
  const inFlightRef = useRef(new Map<number, Promise<string>>());
  /// Bumped on every seek and stop. A render that was already running when the
  /// reader skipped still finishes and still lands in the cache, but must not
  /// be allowed to start playing.
  const genRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /// Set while waiting out the silence between sentences, so pausing in that
  /// gap and then resuming continues rather than replaying.
  const pendingRef = useRef<number | null>(null);
  const docRef = useRef(doc);
  const speedRef = useRef(speed);
  const voiceRef = useRef(voice);

  docRef.current = doc;
  speedRef.current = speed;
  voiceRef.current = voice;

  if (audioRef.current === null && typeof Audio !== "undefined") {
    audioRef.current = new Audio();
  }

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const render = useCallback((index: number): Promise<string> => {
    const cached = cacheRef.current.get(index);
    if (cached) return Promise.resolve(cached);
    const running = inFlightRef.current.get(index);
    if (running) return running;

    const utterance = docRef.current?.utterances[index];
    if (!utterance) return Promise.reject(new Error(`no utterance ${index}`));

    const job = invoke<string>("tts_speak", {
      text: utterance.text,
      voice: voiceRef.current,
    })
      .then((url) => {
        cacheRef.current.set(index, url);
        return url;
      })
      .finally(() => {
        inFlightRef.current.delete(index);
      });
    inFlightRef.current.set(index, job);
    return job;
  }, []);

  /// Warm the next few chunks without waiting for them. Rejections are
  /// swallowed: a lookahead that fails is retried when playback reaches it,
  /// and surfacing the error now would blame the wrong sentence.
  const prefetch = useCallback(
    (from: number) => {
      const total = docRef.current?.utterances.length ?? 0;
      for (let i = from; i < Math.min(from + LOOKAHEAD, total); i++) {
        render(i).catch(() => {});
      }
    },
    [render],
  );

  const play = useCallback(
    async (index: number) => {
      const audio = audioRef.current;
      const currentDoc = docRef.current;
      if (!audio || !currentDoc) return;
      if (index < 0 || index >= currentDoc.utterances.length) {
        setStatus("idle");
        setCurrent(null);
        return;
      }

      clearTimer();
      pendingRef.current = null;
      const gen = ++genRef.current;
      setCurrent(index);
      setError(null);

      // The spinner only belongs on a chunk we actually have to wait for. One
      // already in the cache should start silently.
      const ready = cacheRef.current.has(index);
      if (!ready) {
        const modelOnDisk = await hasModel(voiceRef.current);
        setStatus(modelOnDisk ? "buffering" : "preparing");
      }

      let url: string;
      try {
        url = await render(index);
      } catch (e) {
        if (gen !== genRef.current) return;
        setError(String(e));
        setStatus("error");
        return;
      }
      if (gen !== genRef.current) return;

      audio.src = url;
      audio.playbackRate = speedRef.current;
      try {
        await audio.play();
      } catch (e) {
        if (gen !== genRef.current) return;
        setError(String(e));
        setStatus("error");
        return;
      }
      if (gen !== genRef.current) return;
      setStatus("playing");
      prefetch(index + 1);
    },
    [prefetch, render],
  );

  // Advance when a sentence finishes, after its own trailing silence. The pause
  // is scaled by speed so a 2x reading does not sit through full-length gaps.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => {
      const currentDoc = docRef.current;
      const index = current;
      if (!currentDoc || index === null) return;
      const nextIndex = index + 1;
      if (nextIndex >= currentDoc.utterances.length) {
        // Stop at the end of the file. A PR's file list is not reading order,
        // so rolling into the next one would be a guess.
        setStatus("idle");
        setCurrent(null);
        return;
      }
      const gap = currentDoc.utterances[index].pauseAfterMs / speedRef.current;
      pendingRef.current = nextIndex;
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pendingRef.current = null;
        void play(nextIndex);
      }, gap);
    };
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, [current, play]);

  // Download progress. Only fires on a first play, or the first play after
  // picking a voice that has not been fetched yet.
  useEffect(() => {
    const unlisten = listen<DownloadProgress>("tts:download-progress", (ev) => {
      setProgress(ev.payload);
      setStatus((s) => (s === "playing" || s === "paused" ? s : "preparing"));
      if (ev.payload.received >= ev.payload.total && ev.payload.step === ev.payload.steps) {
        setProgress(null);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const playFrom = useCallback(
    (utterance: number) => {
      void play(utterance);
    },
    [play],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (status === "playing") {
      clearTimer();
      audio.pause();
      setStatus("paused");
      return;
    }
    if (status === "paused") {
      // Paused during the silence between two sentences: resume means start the
      // next one, not replay the element's finished buffer.
      const pending = pendingRef.current;
      if (pending !== null) {
        pendingRef.current = null;
        void play(pending);
        return;
      }
      void audio.play().then(
        () => setStatus("playing"),
        (e) => {
          setError(String(e));
          setStatus("error");
        },
      );
      return;
    }
    if (current !== null) void play(current);
  }, [current, play, status]);

  const next = useCallback(() => {
    if (current !== null) void play(current + 1);
  }, [current, play]);

  const previous = useCallback(() => {
    // Restart the current sentence when more than a moment into it, the way a
    // transcription pedal does. Rewinding is most of what this feature is for,
    // and a skip-back that jumps past the sentence you are still hearing is
    // the wrong one.
    const audio = audioRef.current;
    if (current === null) return;
    if (audio && audio.currentTime > 1.5) {
      void play(current);
      return;
    }
    void play(Math.max(0, current - 1));
  }, [current, play]);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    genRef.current++;
    clearTimer();
    pendingRef.current = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    setStatus("idle");
    setCurrent(null);
    setProgress(null);
  }, []);

  const cycleSpeed = useCallback(
    (reverse = false) => {
      const at = SPEEDS.indexOf(speedRef.current);
      const step = reverse ? -1 : 1;
      onSpeedChange(SPEEDS[(at + step + SPEEDS.length) % SPEEDS.length]);
    },
    [onSpeedChange],
  );

  // Applied to the live element, not just to the next chunk: playbackRate is
  // pitch-corrected, so changing speed mid-sentence is the whole reason
  // playback goes through an <audio> element rather than raw samples.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  // A new document renumbers every utterance, so the cache and the playhead
  // both have to go.
  useEffect(() => {
    cacheRef.current.clear();
    inFlightRef.current.clear();
    stop();
  }, [doc, stop]);

  // Switching voice invalidates every rendered chunk, but not the playhead:
  // the reader wants to hear the same place in the new voice.
  useEffect(() => {
    cacheRef.current.clear();
    inFlightRef.current.clear();
  }, [voice]);

  useEffect(() => () => clearTimer(), []);

  return {
    status,
    current,
    speed,
    progress,
    error,
    playFrom,
    toggle,
    next,
    previous,
    stop,
    cycleSpeed,
  };
}

/// Whether a play would start now or start a download, so the spinner can say
/// "rendering" instead of showing nothing during a 163MB fetch.
async function hasModel(voice: string): Promise<boolean> {
  try {
    return await invoke<boolean>("tts_is_ready", { voice });
  } catch {
    return false;
  }
}
