import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import type { ChapterAudio } from "../hooks/useChapterAudio";

/// The two pieces of player chrome: the play button that appears in a block's
/// gutter on hover, and the pill that holds transport while it is reading.

/// How wide a strip of gutter, in pixels left of the text column, counts as
/// hovering a block. The line number's right edge sits 16px left of the text
/// (see `.prose [data-line-start]::before` in App.css), so this brackets it.
const GUTTER_INSET = 4;
const GUTTER_WIDTH = 44;
/// Height of the button, and therefore of the strip that reveals it. These are
/// the same number on purpose: a block is as tall as its paragraph, so testing
/// against the block's full height revealed the button anywhere down the left
/// edge of a long passage while the button itself stayed pinned to the first
/// line - visible far from the pointer, and nowhere near where it could be
/// clicked. The reveal area and the click area have to be the same rectangle.
/// Kept in sync with `.tts-gutter-play`'s height in App.css by being passed as
/// an inline style below.
const GUTTER_HEIGHT = 22;

/// Only outermost blocks get a button.
///
/// A blockquote stamps `data-line-start` on itself *and* on the paragraphs
/// inside it, and App.css hides the inner numbers so the gutter shows one. The
/// button has to follow that same choice or it would appear where no number is.
function outerBlocks(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-line-start]")).filter(
    (el) => el.parentElement?.closest("[data-line-start]") == null,
  );
}

interface GutterPlayButtonProps {
  proseRef: RefObject<HTMLDivElement | null>;
  /// Re-measure when this changes; the blocks are different elements then.
  contentKey: string;
  onPlayLine: (line: number) => void;
  disabled?: boolean;
}

/// A single button that follows the pointer down the gutter.
///
/// One floating element rather than a button rendered inside every block: the
/// selection anchoring in `anchors.ts` walks the text nodes inside these blocks
/// to place comments, and adding elements into them is how that quietly starts
/// picking the wrong offsets.
export function GutterPlayButton({
  proseRef,
  contentKey,
  onPlayLine,
  disabled,
}: GutterPlayButtonProps) {
  const [hover, setHover] = useState<{ top: number; left: number; line: number } | null>(
    null,
  );

  useEffect(() => setHover(null), [contentKey]);

  // The button replaces the line number, and the number is the block's
  // ::before - unreachable from a sibling element - so hiding it means
  // stamping a class on the block itself while the button is up.
  useEffect(() => {
    const prose = proseRef.current;
    if (!prose || !hover) return;
    const block = outerBlocks(prose).find(
      (el) => Number(el.dataset.lineStart) === hover.line,
    );
    if (!block) return;
    block.classList.add("tts-gutter-hot");
    return () => block.classList.remove("tts-gutter-hot");
  }, [proseRef, hover?.line]);

  useEffect(() => {
    const prose = proseRef.current;
    if (!prose || disabled) return;

    const onMove = (event: MouseEvent) => {
      const blocks = outerBlocks(prose);
      if (blocks.length === 0) return setHover(null);

      const proseRect = prose.getBoundingClientRect();
      const textLeft = blocks[0].getBoundingClientRect().left;
      const stripRight = textLeft - GUTTER_INSET;
      const stripLeft = stripRight - GUTTER_WIDTH;
      if (event.clientX < stripLeft || event.clientX > stripRight) {
        return setHover(null);
      }

      for (const block of blocks) {
        const rect = block.getBoundingClientRect();
        // Centre the band on the block's first text line rather than on its
        // top edge. A heading's line box is much taller than a paragraph's, so
        // a fixed offset would float the button above the words it belongs to.
        const lineHeight = parseFloat(getComputedStyle(block).lineHeight);
        const firstLine = Number.isFinite(lineHeight) ? lineHeight : GUTTER_HEIGHT;
        const bandTop = rect.top + Math.max(0, (firstLine - GUTTER_HEIGHT) / 2);
        if (event.clientY < bandTop || event.clientY > bandTop + GUTTER_HEIGHT) {
          continue;
        }
        const line = Number(block.dataset.lineStart);
        if (!Number.isFinite(line)) break;
        setHover({
          top: bandTop - proseRect.top,
          left: stripLeft - proseRect.left,
          line,
        });
        return;
      }
      setHover(null);
    };

    const onLeave = () => setHover(null);
    prose.addEventListener("mousemove", onMove);
    prose.addEventListener("mouseleave", onLeave);
    // Scrolling under a stationary pointer leaves the button next to the wrong
    // paragraph, and clicking it would then play somewhere the reader did not
    // point at.
    const scroller = prose.closest(".prose-scroll");
    scroller?.addEventListener("scroll", onLeave, { passive: true });
    return () => {
      prose.removeEventListener("mousemove", onMove);
      prose.removeEventListener("mouseleave", onLeave);
      scroller?.removeEventListener("scroll", onLeave);
    };
  }, [proseRef, disabled, contentKey]);

  if (!hover) return null;
  return (
    <button
      className="tts-gutter-play"
      style={{
        top: hover.top,
        left: hover.left,
        width: GUTTER_WIDTH,
        height: GUTTER_HEIGHT,
      }}
      // Without this the pointer-down clears the reader's text selection
      // before the click lands.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onPlayLine(hover.line)}
      // aria-label only - a title attribute pops a native tooltip over the
      // prose, which is exactly where the reader is looking.
      aria-label={`Read from line ${hover.line}`}
    >
      <PlayGlyph />
    </button>
  );
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
      <path d="M3 1.5 L10 6 L3 10.5 Z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
      <rect x="3" y="1.5" width="2.5" height="9" fill="currentColor" />
      <rect x="7" y="1.5" width="2.5" height="9" fill="currentColor" />
    </svg>
  );
}

function formatSpeed(speed: number): string {
  // 1.25x, not 1.3x: the label is the setting, and rounding it makes two of the
  // five steps read the same.
  return `${speed}x`;
}

/// The pill: play/pause, and a speed label you tap to cycle.
///
/// Fixed to the viewport rather than anchored to the sentence being read,
/// because the document deliberately does not follow playback.
export function PlayerPill({ audio }: { audio: ChapterAudio }) {
  const { status, speed, progress } = audio;
  if (status === "idle") return null;

  const busy = status === "preparing" || status === "buffering";
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : null;

  return (
    <div className="tts-pill" role="group" aria-label="Chapter audio">
      <button
        className="tts-pill-button"
        onClick={audio.toggle}
        disabled={status === "error"}
        title={status === "playing" ? "Pause (space)" : "Play (space)"}
        aria-label={status === "playing" ? "Pause" : "Play"}
      >
        {busy ? (
          <span className="tts-spinner" aria-hidden="true" />
        ) : status === "playing" ? (
          <PauseGlyph />
        ) : (
          <PlayGlyph />
        )}
      </button>

      <button
        className="tts-pill-speed"
        // Shift reverses, so getting back to 1x from 2x is one click rather
        // than four.
        onClick={(event) => audio.cycleSpeed(event.shiftKey)}
        title="Playback speed (shift-click to go back)"
        aria-label={`Playback speed ${formatSpeed(speed)}`}
      >
        {formatSpeed(speed)}
      </button>

      {status === "preparing" && percent !== null && (
        <span className="tts-pill-progress" title={`Downloading ${progress?.asset}`}>
          {percent}%
        </span>
      )}
      {status === "error" && (
        <span className="tts-pill-error" title={audio.error ?? "Playback failed"}>
          !
        </span>
      )}
    </div>
  );
}

interface SentenceHighlightProps {
  proseRef: RefObject<HTMLDivElement | null>;
  /// Line range of the block being read, or null.
  block: { lineStart: number; lineEnd: number } | null;
}

/// Tint the block currently being read.
///
/// A class on the block rather than a floating overlay, so it survives the
/// document reflowing underneath it.
export function useSentenceHighlight({ proseRef, block }: SentenceHighlightProps) {
  useLayoutEffect(() => {
    const prose = proseRef.current;
    if (!prose) return;
    if (!block) return;
    const target = outerBlocks(prose).find(
      (el) => Number(el.dataset.lineStart) === block.lineStart,
    );
    if (!target) return;
    target.classList.add("tts-reading");
    return () => target.classList.remove("tts-reading");
  }, [proseRef, block?.lineStart, block?.lineEnd]);
}
