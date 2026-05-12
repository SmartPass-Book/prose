import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import type { ReviewThread } from "./types";
import type { Anchor, AnchorMatch } from "./anchors";
import { ThreadCard } from "./ThreadCard";

const GAP = 8;
const STUB_GAP = 2;
const FALLBACK_CARD_HEIGHT = 80;
const STUB_HEIGHT = 14;

interface MarginRailProps {
  threadsForFile: ReviewThread[];
  threadAnchors: Map<string, Anchor>;
  anchorMatch: Map<string, AnchorMatch>;
  currentUser: string | null;
  highlightedThread: string | null;
  focusedThread: { id: string; sticky: boolean } | null;
  proseRef: React.RefObject<HTMLDivElement | null>;
  proseGridRef: React.RefObject<HTMLDivElement | null>;
  registerThreadEl: (id: string, el: HTMLElement | null) => void;
  onActivate: (thread: ReviewThread) => void;
  onHoverEnter: (thread: ReviewThread) => void;
  onHoverLeave: (thread: ReviewThread, relatedTarget: HTMLElement | null) => void;
  onResolve: (thread: ReviewThread) => void;
  onReply: (thread: ReviewThread, body: string) => void;
  onDelete: (commentId: number) => void;
  fileContent: string;
}

interface Placement {
  threadId: string;
  top: number;
  display: "full" | "compact" | "stub";
}

export function MarginRail({
  threadsForFile,
  threadAnchors,
  anchorMatch,
  currentUser,
  highlightedThread,
  focusedThread,
  proseRef,
  proseGridRef,
  registerThreadEl,
  onActivate,
  onHoverEnter,
  onHoverLeave,
  onResolve,
  onReply,
  onDelete,
  fileContent,
}: MarginRailProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const cardHeights = useRef(new Map<string, number>());
  const cardObserver = useRef<ResizeObserver | null>(null);
  const proseObserver = useRef<ResizeObserver | null>(null);
  const mutationObserver = useRef<MutationObserver | null>(null);
  const rafHandle = useRef<number | null>(null);
  const [tick, setTick] = useState(0);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [railHeight, setRailHeight] = useState(0);
  const [positioned, setPositioned] = useState(false);

  // Schedule a recompute on the next frame, coalescing observer signals.
  const requestRecompute = useCallback(() => {
    if (rafHandle.current !== null) return;
    rafHandle.current = requestAnimationFrame(() => {
      rafHandle.current = null;
      setTick((t) => t + 1);
    });
  }, []);

  useEffect(() => {
    cardObserver.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const id = el.dataset.threadId;
        if (!id) continue;
        const h = el.offsetHeight;
        if (cardHeights.current.get(id) !== h) {
          cardHeights.current.set(id, h);
          changed = true;
        }
      }
      if (changed) requestRecompute();
    });
    return () => {
      cardObserver.current?.disconnect();
      cardObserver.current = null;
    };
  }, [requestRecompute]);

  useEffect(() => {
    const prose = proseRef.current;
    if (!prose) return;
    proseObserver.current = new ResizeObserver(requestRecompute);
    proseObserver.current.observe(prose);
    mutationObserver.current = new MutationObserver(requestRecompute);
    mutationObserver.current.observe(prose, {
      childList: true,
      subtree: true,
      characterData: false,
    });
    return () => {
      proseObserver.current?.disconnect();
      mutationObserver.current?.disconnect();
      proseObserver.current = null;
      mutationObserver.current = null;
    };
  }, [proseRef, requestRecompute]);

  useEffect(() => {
    const handler = () => requestRecompute();
    window.addEventListener("resize", handler);
    if (typeof document !== "undefined" && (document as any).fonts?.ready) {
      (document as any).fonts.ready.then(handler);
    }
    return () => window.removeEventListener("resize", handler);
  }, [requestRecompute]);

  useLayoutEffect(() => {
    const prose = proseRef.current;
    const grid = proseGridRef.current;
    if (!prose || !grid) return;

    const blocks = Array.from(
      prose.querySelectorAll<HTMLElement>("[data-line-start]"),
    );
    if (blocks.length === 0 && threadsForFile.length === 0) {
      setPlacements([]);
      setRailHeight(0);
      return;
    }

    const gridRect = grid.getBoundingClientRect();
    const focusedId = focusedThread?.id ?? null;

    type Item = { thread: ReviewThread; desiredTop: number };
    const items: Item[] = [];
    for (const t of threadsForFile) {
      const lineEnd = t.line ?? t.originalLine ?? 0;
      if (!lineEnd) continue;
      const startLine = t.startLine ?? lineEnd;
      const lo = Math.min(startLine, lineEnd);
      let anchor: HTMLElement | null = null;
      for (const b of blocks) {
        const s = parseInt(b.dataset.lineStart!, 10);
        const e = parseInt(b.dataset.lineEnd!, 10);
        if (s <= lo && e >= lo) {
          anchor = b;
          break;
        }
      }
      if (!anchor) continue;
      const blockRect = anchor.getBoundingClientRect();
      const desiredTop = blockRect.top - gridRect.top + grid.scrollTop;
      items.push({ thread: t, desiredTop });
    }

    items.sort(
      (a, b) =>
        a.desiredTop - b.desiredTop ||
        (a.thread.line ?? 0) - (b.thread.line ?? 0) ||
        a.thread.id.localeCompare(b.thread.id),
    );

    const next: Placement[] = [];
    if (focusedId) {
      // Focused mode: the focused card sits at its anchor; all other cards
      // collapse to thin stubs cascading above/below it.
      const focusedItem = items.find((it) => it.thread.id === focusedId);
      const others = items.filter((it) => it.thread.id !== focusedId);
      const focusedTop = focusedItem?.desiredTop ?? 0;
      const focusedHeight = focusedItem
        ? cardHeights.current.get(focusedItem.thread.id) ?? FALLBACK_CARD_HEIGHT
        : 0;
      const focusedBottom = focusedTop + focusedHeight;

      // Stubs above the focused card: cascade downward from each desiredTop,
      // but cap so they don't collide with the focused card.
      const above: Item[] = [];
      const below: Item[] = [];
      for (const it of others) {
        if (it.desiredTop < focusedTop) above.push(it);
        else below.push(it);
      }
      let cursor = 0;
      for (const it of above) {
        const top = Math.max(it.desiredTop, cursor);
        // If a stub would overlap the focused card, push it just above.
        const capped = Math.min(top, focusedTop - STUB_HEIGHT - STUB_GAP);
        next.push({ threadId: it.thread.id, top: capped, display: "stub" });
        cursor = capped + STUB_HEIGHT + STUB_GAP;
      }
      if (focusedItem) {
        next.push({
          threadId: focusedItem.thread.id,
          top: focusedTop,
          display: "full",
        });
      }
      cursor = focusedBottom + STUB_GAP;
      for (const it of below) {
        const top = Math.max(it.desiredTop, cursor);
        next.push({ threadId: it.thread.id, top, display: "stub" });
        cursor = top + STUB_HEIGHT + STUB_GAP;
      }
      setPlacements(next);
      setRailHeight(Math.max(cursor, prose.offsetHeight));
    } else {
      // Idle: cascade with compact cards.
      let cursor = 0;
      for (const it of items) {
        const measured =
          cardHeights.current.get(it.thread.id) ?? FALLBACK_CARD_HEIGHT;
        const top = Math.max(it.desiredTop, cursor + GAP);
        next.push({ threadId: it.thread.id, top, display: "compact" });
        cursor = top + measured + GAP;
      }
      setPlacements(next);
      setRailHeight(Math.max(cursor, prose.offsetHeight));
    }
    if (!positioned) setPositioned(true);
  }, [
    threadsForFile,
    threadAnchors,
    anchorMatch,
    fileContent,
    highlightedThread,
    focusedThread,
    tick,
    proseRef,
    proseGridRef,
    positioned,
  ]);

  const handleCardRef = useCallback(
    (id: string, el: HTMLElement | null) => {
      if (el) {
        el.dataset.threadId = id;
        cardObserver.current?.observe(el);
        const h = el.offsetHeight;
        if (cardHeights.current.get(id) !== h) {
          cardHeights.current.set(id, h);
        }
      } else {
        cardHeights.current.delete(id);
      }
      registerThreadEl(id, el);
    },
    [registerThreadEl],
  );

  const placementById = new Map<string, Placement>();
  for (const p of placements) placementById.set(p.threadId, p);

  return (
    <div
      className={`rail ${focusedThread ? "focused" : ""}`}
      ref={railRef}
      style={{ height: railHeight ? `${railHeight}px` : undefined }}
      data-positioned={positioned ? "true" : "false"}
    >
      <ul className="thread-list">
        {threadsForFile.map((t) => {
          const placement = placementById.get(t.id);
          if (!placement) return null;
          return (
            <ThreadCard
              key={t.id}
              thread={t}
              anchor={threadAnchors.get(t.id) ?? null}
              matchState={anchorMatch.get(t.id) ?? null}
              currentUser={currentUser}
              highlighted={highlightedThread === t.id}
              display={placement.display}
              registerEl={(el) => handleCardRef(t.id, el)}
              onActivate={() => onActivate(t)}
              onHoverEnter={() => onHoverEnter(t)}
              onHoverLeave={(rel) => onHoverLeave(t, rel)}
              onResolve={() => onResolve(t)}
              onReply={(body) => onReply(t, body)}
              onDelete={onDelete}
              style={{ position: "absolute", top: `${placement.top}px`, left: 0, right: 0 }}
            />
          );
        })}
      </ul>
    </div>
  );
}
