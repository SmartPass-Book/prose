import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { extractSpeakable, utteranceForLine, type SpeakableDoc } from "../lib/speech";
import { findSentenceRange, selectRange } from "../lib/sentenceRange";
import { useChapterAudio, type ChapterAudio, type Speed } from "./useChapterAudio";

/// The whole player, assembled: markdown to sentences, sentences to audio, and
/// the block being read back out for the highlight.

export interface ChapterPlayer {
  doc: SpeakableDoc | null;
  /// `toggle` here also jumps the document to the playhead; everything else is
  /// the raw controller.
  audio: ChapterAudio;
  /// True while a chapter is loaded, whether or not it is currently sounding.
  active: boolean;
  /// The block currently being read, for the highlight.
  readingBlock: { lineStart: number; lineEnd: number } | null;
  /// Start reading at the block whose gutter was clicked.
  playFromLine: (line: number) => void;
  /// Pause and select the sentence being read, so the composer can anchor to
  /// it. Returns false when there is nothing to select.
  captureSpokenSentence: () => boolean;
  /// Resume after a comment was posted or cancelled, if `captureSpokenSentence`
  /// was what paused playback.
  resumeAfterComment: () => void;
}

interface Options {
  activeFile: string | null;
  fileContent: string;
  proseRef: RefObject<HTMLDivElement | null>;
  voice: string;
  speed: Speed;
  onSpeedChange: (speed: Speed) => void;
}

export function useChapterPlayer({
  activeFile,
  fileContent,
  proseRef,
  voice,
  speed,
  onSpeedChange,
}: Options): ChapterPlayer {
  // Parsing a chapter is cheap, but a poll that returns identical content would
  // otherwise redo it, so it is memoized on the text.
  const doc = useMemo(
    () => (fileContent ? extractSpeakable(fileContent) : null),
    [fileContent],
  );

  const audio = useChapterAudio(doc, voice, speed, onSpeedChange);
  /// Set when `c` paused playback, so resuming is only automatic for a pause
  /// this hook caused - not one the reader asked for and then commented during.
  const pausedForCommentRef = useRef(false);

  const readingBlock = useMemo(() => {
    if (!doc || audio.current === null) return null;
    const utterance = doc.utterances[audio.current];
    if (!utterance) return null;
    const block = doc.blocks[utterance.block];
    return block ? { lineStart: block.lineStart, lineEnd: block.lineEnd } : null;
  }, [doc, audio.current]);

  const blockElement = useCallback(
    (lineStart: number): HTMLElement | null => {
      const prose = proseRef.current;
      if (!prose) return null;
      return (
        Array.from(prose.querySelectorAll<HTMLElement>("[data-line-start]")).find(
          (el) =>
            Number(el.dataset.lineStart) === lineStart &&
            el.parentElement?.closest("[data-line-start]") == null,
        ) ?? null
      );
    },
    [proseRef],
  );

  /// Bring the playhead into view.
  ///
  /// Only on an explicit play or pause. The document does not follow playback -
  /// scrolling the page out from under someone reading along is worse than
  /// making them find their place once - but pressing play is a statement that
  /// the playhead is where they want to be.
  const jumpToPlayhead = useCallback(() => {
    if (!readingBlock) return;
    blockElement(readingBlock.lineStart)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [blockElement, readingBlock]);

  const toggle = useCallback(() => {
    audio.toggle();
    jumpToPlayhead();
  }, [audio, jumpToPlayhead]);

  const playFromLine = useCallback(
    (line: number) => {
      if (!doc) return;
      const index = utteranceForLine(doc, line);
      if (index !== null) audio.playFrom(index);
    },
    [audio, doc],
  );

  const captureSpokenSentence = useCallback(() => {
    if (!doc || audio.current === null || !readingBlock) return false;
    const element = blockElement(readingBlock.lineStart);
    if (!element) return false;
    const range = findSentenceRange(element, doc.utterances[audio.current].text);
    if (!range) return false;

    if (audio.status === "playing") {
      audio.toggle();
      pausedForCommentRef.current = true;
    }
    selectRange(range);
    return true;
  }, [audio, blockElement, doc, readingBlock]);

  const resumeAfterComment = useCallback(() => {
    if (!pausedForCommentRef.current) return;
    pausedForCommentRef.current = false;
    audio.toggle();
  }, [audio]);

  // Stop at a file or PR switch rather than reading on from the same offset
  // into a different document. The audio hook already resets on a new `doc`,
  // but content for the new file arrives a moment later, and until it does the
  // reader would hear the old chapter continue.
  const { stop } = audio;
  useEffect(() => stop(), [activeFile, stop]);

  const wrapped = useMemo<ChapterAudio>(() => ({ ...audio, toggle }), [audio, toggle]);

  return {
    doc,
    audio: wrapped,
    active: audio.status !== "idle",
    readingBlock,
    playFromLine,
    captureSpokenSentence,
    resumeAfterComment,
  };
}
