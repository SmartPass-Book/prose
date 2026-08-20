import { useCallback, useEffect, useMemo } from "react";
import { extractSpeakable, utteranceForLine, type SpeakableDoc } from "../lib/speech";
import { useChapterAudio, type ChapterAudio, type Speed } from "./useChapterAudio";

/// The whole player, assembled: markdown to sentences, sentences to audio, and
/// the block being read back out for the highlight.

export interface ChapterPlayer {
  doc: SpeakableDoc | null;
  audio: ChapterAudio;
  /// The block currently being read, for the highlight and the jump target.
  readingBlock: { lineStart: number; lineEnd: number } | null;
  /// Start reading at the block whose gutter was clicked.
  playFromLine: (line: number) => void;
}

interface Options {
  activeFile: string | null;
  fileContent: string;
  voice: string;
  speed: Speed;
  onSpeedChange: (speed: Speed) => void;
}

export function useChapterPlayer({
  activeFile,
  fileContent,
  voice,
  speed,
  onSpeedChange,
}: Options): ChapterPlayer {
  // Parsing a chapter is cheap, but it happens on every keystroke of a poll
  // that returns identical content, so it is worth memoizing on the text.
  const doc = useMemo(
    () => (fileContent ? extractSpeakable(fileContent) : null),
    [fileContent],
  );

  const audio = useChapterAudio(doc, voice, speed, onSpeedChange);

  const readingBlock = useMemo(() => {
    if (!doc || audio.current === null) return null;
    const utterance = doc.utterances[audio.current];
    if (!utterance) return null;
    const block = doc.blocks[utterance.block];
    return block ? { lineStart: block.lineStart, lineEnd: block.lineEnd } : null;
  }, [doc, audio.current]);

  const playFromLine = useCallback(
    (line: number) => {
      if (!doc) return;
      const index = utteranceForLine(doc, line);
      if (index !== null) audio.playFrom(index);
    },
    [audio, doc],
  );

  // Stop at a file or PR switch rather than reading on from the same offset
  // into a different document. The audio hook already resets on a new `doc`,
  // but a file whose content has not arrived yet leaves `doc` unchanged for a
  // moment, and the reader would hear the old chapter continue.
  const { stop } = audio;
  useEffect(() => stop(), [activeFile, stop]);

  return { doc, audio, readingBlock, playFromLine };
}
