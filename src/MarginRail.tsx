import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import type { ReviewThread } from "./types";
import type { Anchor, AnchorMatch } from "./anchors";
import { ThreadCard } from "./ThreadCard";

const GAP = 8;
const FALLBACK_CARD_HEIGHT = 80;
const LEADER_LINE_THRESHOLD = 8;

interface MarginRailProps {
  threadsForFile: ReviewThread[];
  threadAnchors: Map<string, Anchor>;
  anchorMatch: Map<string, AnchorMatch>;
  currentUser: string | null;
  highlightedThread: string | null;
  newThreadIds: Set<string>;
  proseRef: React.RefObject<HTMLDivElement | null>;
  proseGridRef: React.RefObject<HTMLDivElement | null>;
  registerThreadEl: (id: string, el: HTMLElement | null) => void;
  onActivate: (thread: ReviewThread) => void;
  onResolve: (thread: ReviewThread) => void;
  onReply: (thread: ReviewThread, body: string) => void;
  onDelete: (commentId: number) => void;
  fileContent: string;
}

interface Placement {
  threadId: string;
  top: number;
  shift: number;
  anchorBlockTop: number;
  anchorBlockHeight: number;
}

export function MarginRail({
  threadsForFile,
  threadAnchors,
  anchorMatch,
  currentUser,
  highlightedThread,
  newThreadIds,
  proseRef,
  proseGridRef,
  registerThreadEl,
  onActivate,
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

  // Card ResizeObserver: track card heights to keep cascade accurate.
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

  // Prose ResizeObserver + MutationObserver: catch font-load shifts, walker
  // injecting <mark>s, react-markdown re-renders, etc.
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

  // Window resize + font ready.
  useEffect(() => {
    const handler = () => requestRecompute();
    window.addEventListener("resize", handler);
    if (typeof document !== "undefined" && (document as any).fonts?.ready) {
      (document as any).fonts.ready.then(handler);
    }
    return () => window.removeEventListener("resize", handler);
  }, [requestRecompute]);

  // Cascade layout. useLayoutEffect so positions commit before paint.
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

    type Item = {
      thread: ReviewThread;
      desiredTop: number;
      anchorBlockTop: number;
      anchorBlockHeight: number;
    };
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
      items.push({
        thread: t,
        desiredTop,
        anchorBlockTop: desiredTop,
        anchorBlockHeight: blockRect.height,
      });
    }

    items.sort(
      (a, b) =>
        a.desiredTop - b.desiredTop ||
        (a.thread.line ?? 0) - (b.thread.line ?? 0) ||
        a.thread.id.localeCompare(b.thread.id),
    );

    let cursor = 0;
    const next: Placement[] = [];
    for (const it of items) {
      const measured = cardHeights.current.get(it.thread.id) ?? FALLBACK_CARD_HEIGHT;
      const top = Math.max(it.desiredTop, cursor + GAP);
      next.push({
        threadId: it.thread.id,
        top,
        shift: top - it.desiredTop,
        anchorBlockTop: it.anchorBlockTop,
        anchorBlockHeight: it.anchorBlockHeight,
      });
      cursor = top + measured + GAP;
    }

    setPlacements(next);
    setRailHeight(Math.max(cursor, prose.offsetHeight));
    if (!positioned) setPositioned(true);
  }, [
    threadsForFile,
    threadAnchors,
    anchorMatch,
    fileContent,
    highlightedThread,
    tick,
    proseRef,
    proseGridRef,
    positioned,
  ]);

  // Per-card ref registration: register in App's threadRefs map AND observe
  // for height changes.
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

  // Keep a quick lookup of placements by id.
  const placementById = new Map<string, Placement>();
  for (const p of placements) placementById.set(p.threadId, p);

  return (
    <div
      className="rail"
      ref={railRef}
      style={{ height: railHeight ? `${railHeight}px` : undefined }}
      data-positioned={positioned ? "true" : "false"}
    >
      <svg className="rail-leaders" aria-hidden="true">
        {placements
          .filter((p) => Math.abs(p.shift) > LEADER_LINE_THRESHOLD)
          .map((p) => {
            const isActive = highlightedThread === p.threadId;
            return (
              <line
                key={p.threadId}
                x1={-24}
                y1={p.anchorBlockTop + p.anchorBlockHeight / 2}
                x2={0}
                y2={p.top + 12}
                className={isActive ? "leader active" : "leader"}
              />
            );
          })}
      </svg>
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
              isNew={newThreadIds.has(t.id)}
              registerEl={(el) => handleCardRef(t.id, el)}
              onActivate={() => onActivate(t)}
              onResolve={() => onResolve(t)}
              onReply={(body) => onReply(t, body)}
              onDelete={onDelete}
              style={{ position: "absolute", top: `${placement.top}px`, left: 0, right: 0 }}
              extraClass={Math.abs(placement.shift) > LEADER_LINE_THRESHOLD ? "shifted" : ""}
            />
          );
        })}
      </ul>
    </div>
  );
}
