import { useCallback, useEffect, useState, type RefObject } from "react";
import type { ReviewThread } from "../types";

interface MobileGutterProps {
  scrollRef: RefObject<HTMLElement | null>;
  proseRef: RefObject<HTMLDivElement | null>;
  threads: ReviewThread[];
  highlighted: string | null;
  /** Re-measure when the rendered text changes, not just when threads do. */
  contentKey: string;
  onSelectThread: (thread: ReviewThread) => void;
}

interface Tick {
  thread: ReviewThread;
  /** Position down the document, 0-1. */
  at: number;
  resolved: boolean;
}

/**
 * The margin, compressed to a rail.
 *
 * Desktop Prose shows comment threads in a true margin beside the text. A
 * phone has no room for that, and simply dropping it makes every note
 * invisible until you happen to tap the right paragraph. This puts a tick at
 * the proportional position of each annotated paragraph, so the shape of the
 * review is visible at a glance and any note is one tap away.
 *
 * Positions are measured from the laid-out DOM rather than computed from line
 * numbers, because a markdown line number has no fixed relationship to
 * vertical position once the text is wrapped and styled.
 */
export function MobileGutter({
  scrollRef,
  proseRef,
  threads,
  highlighted,
  contentKey,
  onSelectThread,
}: MobileGutterProps) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [progress, setProgress] = useState(0);

  const measure = useCallback(() => {
    const root = proseRef.current;
    if (!root) return;
    const total = root.scrollHeight;
    if (!total) return;

    const blocks = Array.from(
      root.querySelectorAll<HTMLElement>("[data-line-start]"),
    );

    const next: Tick[] = [];
    for (const thread of threads) {
      // Prefer the actual inline mark: it is where the reader's eye will go,
      // and it survives text that has shifted since the note was written.
      const mark = root.querySelector<HTMLElement>(
        `mark.comment-highlight[data-thread-id="${CSS.escape(thread.clientKey)}"]`,
      );
      let element: HTMLElement | null =
        mark?.closest<HTMLElement>("[data-line-start]") ?? null;

      if (!element) {
        const line = thread.line ?? thread.originalLine;
        if (line) {
          element =
            blocks.find((block) => {
              const start = Number(block.dataset.lineStart);
              const end = Number(block.dataset.lineEnd);
              return start <= line && end >= line;
            }) ?? null;
        }
      }
      // A file-level note with no resolvable anchor has no position on the
      // page, so it gets no tick rather than a misleading one at the top.
      if (!element) continue;

      next.push({
        thread,
        at: (element.offsetTop + element.offsetHeight / 2) / total,
        resolved: thread.isResolved,
      });
    }
    setTicks(next);
  }, [proseRef, threads]);

  useEffect(() => {
    measure();
    const root = proseRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    // Fonts loading and images settling both change offsets after first paint.
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure, proseRef, contentKey]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const range = scroller.scrollHeight - scroller.clientHeight;
      setProgress(range > 0 ? scroller.scrollTop / range : 0);
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scrollRef, contentKey]);

  return (
    <div className="gutter" aria-hidden={ticks.length === 0}>
      <div
        className="gutter-progress"
        style={{ height: `${Math.min(100, Math.max(0, progress * 100))}%` }}
      />
      {ticks.map((tick) => (
        <button
          key={tick.thread.clientKey}
          type="button"
          aria-label={`Note on line ${tick.thread.line ?? tick.thread.originalLine ?? ""}`}
          onClick={() => onSelectThread(tick.thread)}
          // The tick is 2px tall; the hit target around it is finger-sized.
          className="gutter-hit"
          style={{ top: `${tick.at * 100}%` }}
        >
          <span
            className={`gutter-tick ${tick.resolved ? "resolved" : ""} ${
              highlighted === tick.thread.clientKey ? "active" : ""
            }`}
          />
        </button>
      ))}
    </div>
  );
}
