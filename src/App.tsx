import { useEffect, useMemo, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import {
  buildCommentBody,
  captureAnchorFromRange,
  findAnchorRange,
  parseAnchor,
  stripAnchorFromBody,
  type Anchor,
  type AnchorMatch,
} from "./anchors";
import type { PR, PRSummary, ReviewComment, ReviewThread } from "./types";
import "./App.css";

const REPO_KEY = "nr.repo";
const SIDEBAR_HIDDEN_KEY = "nr.sidebarHidden";
const THREADS_WIDTH_KEY = "nr.threadsWidth";
const DEFAULT_REPO = "SmartPass-Book/book";
const DEFAULT_THREADS_WIDTH = 360;
const MIN_THREADS_WIDTH = 240;
const MAX_THREADS_WIDTH = 720;

type LineRange = { start: number; end: number };

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function activityFreshness(iso: string): "fresh" | "recent" | "stale" {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 5 * 60_000) return "fresh";
  if (ms < 60 * 60_000) return "recent";
  return "stale";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

function threadsEqual(a: ReviewThread[], b: ReviewThread[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ta = a[i], tb = b[i];
    if (
      ta.id !== tb.id ||
      ta.isResolved !== tb.isResolved ||
      ta.isOutdated !== tb.isOutdated ||
      ta.line !== tb.line ||
      ta.startLine !== tb.startLine ||
      ta.originalLine !== tb.originalLine ||
      ta.path !== tb.path ||
      (ta.pendingOp ?? null) !== (tb.pendingOp ?? null)
    ) return false;
    const ca = ta.comments.nodes;
    const cb = tb.comments.nodes;
    if (ca.length !== cb.length) return false;
    for (let j = 0; j < ca.length; j++) {
      if (ca[j].id !== cb[j].id || ca[j].body !== cb[j].body) return false;
    }
  }
  return true;
}

function App() {
  const [repo, setRepo] = useState<string>(
    () => localStorage.getItem(REPO_KEY) || DEFAULT_REPO,
  );
  const [prs, setPRs] = useState<PRSummary[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedPR, setSelectedPR] = useState<PR | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selRange, setSelRange] = useState<LineRange | null>(null);
  const [selAnchor, setSelAnchor] = useState<Anchor | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerBody, setComposerBody] = useState("");
  const [anchorMatch, setAnchorMatch] = useState<Map<string, AnchorMatch>>(
    new Map(),
  );
  const [highlightedThread, setHighlightedThread] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [newThreadIds, setNewThreadIds] = useState<Set<string>>(new Set());
  const [peterChipTop, setPeterChipTop] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  const [sidebarHidden, setSidebarHidden] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1",
  );
  const [threadsWidth, setThreadsWidth] = useState<number>(() => {
    const v = parseInt(localStorage.getItem(THREADS_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(v) && v >= MIN_THREADS_WIDTH && v <= MAX_THREADS_WIDTH
      ? v
      : DEFAULT_THREADS_WIDTH;
  });
  const proseRef = useRef<HTMLDivElement>(null);
  const threadRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerThreadEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) threadRefs.current.set(id, el);
    else threadRefs.current.delete(id);
  }, []);
  const flashThread = useCallback((id: string) => {
    setHighlightedThread(id);
    const el = threadRefs.current.get(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  useEffect(() => {
    localStorage.setItem(REPO_KEY, repo);
  }, [repo]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, sidebarHidden ? "1" : "0");
  }, [sidebarHidden]);

  useEffect(() => {
    localStorage.setItem(THREADS_WIDTH_KEY, String(threadsWidth));
  }, [threadsWidth]);

  // Drag handle for threads panel
  const startResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = threadsWidth;
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const next = Math.min(
        MAX_THREADS_WIDTH,
        Math.max(MIN_THREADS_WIDTH, startWidth + delta),
      );
      setThreadsWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [threadsWidth]);

  const loadPRs = useCallback(
    async (force = false) => {
      setLoading(true);
      setErr(null);
      try {
        const list = force ? await api.refreshPRs(repo) : await api.listPRs(repo);
        setPRs(list);
      } catch (e: any) {
        setErr(String(e));
      } finally {
        setLoading(false);
      }
    },
    [repo],
  );

  useEffect(() => {
    loadPRs();
    api.getCurrentUser().then(setCurrentUser).catch(() => {});
  }, [loadPRs]);

  // Tick every 30s so relative timestamps re-render
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Tell the Rust poll loop which PR to watch. The loop runs in the background
  // and emits `cache:threads-updated` events; we listen below.
  useEffect(() => {
    if (!selectedPR) {
      api.setActivePR(null, null).catch(() => {});
      return;
    }
    api.setActivePR(repo, selectedPR.number).catch(() => {});
    return () => {
      api.setActivePR(null, null).catch(() => {});
    };
  }, [selectedPR, repo]);

  // Track focus so the backend can poll less aggressively when blurred.
  useEffect(() => {
    const send = () => {
      api.setFocus(document.visibilityState === "visible").catch(() => {});
    };
    send();
    document.addEventListener("visibilitychange", send);
    return () => document.removeEventListener("visibilitychange", send);
  }, []);

  // Subscribe to thread cache updates from Rust. When the active PR's threads
  // change, refetch from the (now-warm) cache.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ repo: string; number: number }>("cache:threads-updated", async (ev) => {
      if (!selectedPR) return;
      if (ev.payload.repo !== repo || ev.payload.number !== selectedPR.number) return;
      try {
        const fetched = await api.getThreads(repo, selectedPR.number);
        setThreads((prev) => {
          if (threadsEqual(prev, fetched)) return prev;
          const prevIds = new Set(prev.map((x) => x.id));
          const arrivals = fetched.filter((x) => !prevIds.has(x.id)).map((x) => x.id);
          if (arrivals.length && prev.length > 0) {
            setNewThreadIds((s) => {
              const next = new Set(s);
              arrivals.forEach((i) => next.add(i));
              return next;
            });
            setTimeout(() => {
              setNewThreadIds((s) => {
                const next = new Set(s);
                arrivals.forEach((i) => next.delete(i));
                return next;
              });
            }, 4000);
          }
          return fetched;
        });
      } catch {
        // ignore
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [selectedPR, repo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "Escape") {
        if (composerOpen) {
          setComposerOpen(false);
          return;
        }
        if (selRange) {
          setSelRange(null);
          window.getSelection()?.removeAllRanges();
          return;
        }
        if (highlightedThread) {
          setHighlightedThread(null);
        }
        return;
      }
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (inField) return;
      if (selRange && !composerOpen) {
        e.preventDefault();
        setComposerOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selRange, composerOpen, highlightedThread]);

  const openPR = useCallback(
    async (number: number) => {
      // Don't clear current state — keep old PR visible until new content is
      // ready, then atomic-swap. Avoids the empty-state flash when everything
      // is cached.
      setLoading(true);
      setErr(null);
      try {
        // Fetch PR and threads concurrently so we can pick the right initial
        // file (the one with the most unresolved threads).
        const [pr, threadsList] = await Promise.all([
          api.getPR(repo, number),
          api.getThreads(repo, number),
        ]);

        const counts = new Map<string, number>();
        for (const t of threadsList) {
          if (t.isResolved) continue;
          counts.set(t.path, (counts.get(t.path) ?? 0) + 1);
        }
        const sortedFiles = [...pr.files].sort(
          (a, b) =>
            (counts.get(b.path) ?? 0) - (counts.get(a.path) ?? 0) ||
            a.path.localeCompare(b.path),
        );
        // Prefer top of sorted list (file with most unresolved comments). If
        // nothing has unresolved threads, fall back to first .md, then first.
        const initial =
          sortedFiles.find((f) => (counts.get(f.path) ?? 0) > 0) ??
          sortedFiles.find((f) => f.path.endsWith(".md")) ??
          sortedFiles[0];

        const content = initial
          ? await api.getFile(repo, pr.headRefOid, initial.path)
          : "";

        setSelectedPR(pr);
        setActiveFile(initial?.path ?? null);
        setFileContent(content);
        setThreads(threadsList);
      } catch (e: any) {
        setErr(String(e));
      } finally {
        setLoading(false);
      }
    },
    [repo],
  );

  const switchFile = useCallback(
    async (path: string) => {
      if (!selectedPR) return;
      setActiveFile(path);
      setFileContent("");
      try {
        const content = await api.getFile(repo, selectedPR.headRefOid, path);
        setFileContent(content);
      } catch (e: any) {
        setErr(String(e));
      }
    },
    [repo, selectedPR],
  );

  const onMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelRange(null);
      setSelAnchor(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!proseRef.current?.contains(range.commonAncestorContainer)) {
      setSelRange(null);
      setSelAnchor(null);
      return;
    }
    setSelAnchor(captureAnchorFromRange(range, proseRef.current));
    const findLineEl = (node: Node | null): HTMLElement | null => {
      let n: Node | null = node;
      while (n && n !== proseRef.current) {
        if (n instanceof HTMLElement && n.dataset.lineStart) return n;
        n = n.parentNode;
      }
      return null;
    };
    const startEl = findLineEl(range.startContainer);
    const endEl = findLineEl(range.endContainer);
    if (!startEl || !endEl) {
      setSelRange(null);
      setSelAnchor(null);
      return;
    }
    const start = Math.min(
      parseInt(startEl.dataset.lineStart!, 10),
      parseInt(endEl.dataset.lineStart!, 10),
    );
    const end = Math.max(
      parseInt(startEl.dataset.lineEnd!, 10),
      parseInt(endEl.dataset.lineEnd!, 10),
    );
    setSelRange({ start, end });
  }, []);

  const submitComment = useCallback(async () => {
    if (!selectedPR || !activeFile || !selRange || !composerBody.trim()) return;
    setErr(null);
    try {
      // Optimistic: backend inserts a tmp thread + comment + enqueues op.
      await api.mutatePostComment({
        repo,
        number: selectedPR.number,
        commitId: selectedPR.headRefOid,
        path: activeFile,
        line: selRange.end,
        startLine: selRange.start === selRange.end ? undefined : selRange.start,
        body: buildCommentBody(composerBody, selAnchor),
      });
      setComposerBody("");
      setComposerOpen(false);
      setSelRange(null);
      setSelAnchor(null);
      window.getSelection()?.removeAllRanges();
    } catch (e: any) {
      setErr(String(e));
    }
  }, [activeFile, composerBody, repo, selRange, selAnchor, selectedPR]);

  const refreshThreads = useCallback(async () => {
    if (!selectedPR) return;
    try {
      const t = await api.getThreads(repo, selectedPR.number);
      setThreads(t);
    } catch (e: any) {
      setErr(String(e));
    }
  }, [repo, selectedPR]);

  const toggleResolve = useCallback(
    async (thread: ReviewThread) => {
      try {
        // Optimistic: backend flips local state + enqueues op + emits a
        // cache:threads-updated event we'll pick up to re-render.
        await api.mutateResolve(thread.id, !thread.isResolved);
      } catch (e: any) {
        setErr(String(e));
      }
    },
    [],
  );

  const deleteComment = useCallback(
    async (commentId: number) => {
      try {
        // Optimistic: backend soft-deletes locally + enqueues op + emits event.
        await api.mutateDeleteComment(repo, commentId);
      } catch (e: any) {
        setErr(String(e));
      }
    },
    [repo],
  );

  const replyTo = useCallback(
    async (thread: ReviewThread, body: string) => {
      if (!selectedPR) return;
      const first = thread.comments.nodes[0];
      if (!first) return;
      try {
        await api.mutateReply({
          threadId: thread.id,
          repo,
          number: selectedPR.number,
          inReplyTo: first.databaseId,
          body,
        });
      } catch (e: any) {
        setErr(String(e));
      }
    },
    [repo, selectedPR],
  );

  const filteredPRs = useMemo(() => {
    const f = filter.toLowerCase();
    return prs.filter(
      (p) =>
        !f ||
        p.title.toLowerCase().includes(f) ||
        String(p.number).includes(f) ||
        p.headRefName.toLowerCase().includes(f),
    );
  }, [prs, filter]);

  const threadsForFile = useMemo(
    () => threads.filter((t) => t.path === activeFile),
    [threads, activeFile],
  );

  // Files for the active PR, sorted by unresolved thread count (desc) then path.
  const filesSorted = useMemo(() => {
    if (!selectedPR) return [];
    const counts = new Map<string, number>();
    for (const t of threads) {
      if (t.isResolved) continue;
      counts.set(t.path, (counts.get(t.path) ?? 0) + 1);
    }
    return [...selectedPR.files]
      .map((f) => ({ ...f, unresolved: counts.get(f.path) ?? 0 }))
      .sort(
        (a, b) =>
          b.unresolved - a.unresolved || a.path.localeCompare(b.path),
      );
  }, [selectedPR, threads]);

  // Pre-parse the leading comment's anchor for each thread
  const threadAnchors = useMemo(() => {
    const m = new Map<string, Anchor>();
    for (const t of threadsForFile) {
      const first = t.comments.nodes[0];
      if (!first) continue;
      const a = parseAnchor(first.body);
      if (a) m.set(t.id, a);
    }
    return m;
  }, [threadsForFile]);

  // Post-render walker: wraps the anchored phrase in each block with a <mark>.
  // Only touches the specific blocks needing changes, and skips any block that
  // currently contains the user's text selection so live selections survive
  // background polling updates.
  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;

    // Find blocks that intersect the active selection — leave those alone.
    const sel = window.getSelection();
    const skipBlocks = new Set<HTMLElement>();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const find = (n: Node | null): HTMLElement | null => {
        let cur: Node | null = n;
        while (cur && cur !== root) {
          if (cur instanceof HTMLElement && cur.dataset.lineStart) return cur;
          cur = cur.parentNode;
        }
        return null;
      };
      const a = find(range.startContainer);
      const b = find(range.endContainer);
      if (a) skipBlocks.add(a);
      if (b) skipBlocks.add(b);
    }

    // Unwrap existing marks (only in non-skipped blocks).
    const touched = new Set<HTMLElement>();
    root.querySelectorAll("mark.word-anchor").forEach((m) => {
      const block = (m as HTMLElement).closest("[data-line-start]") as HTMLElement | null;
      if (block && skipBlocks.has(block)) return;
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      if (block) touched.add(block);
    });
    touched.forEach((b) => b.normalize());

    const newMatch = new Map<string, AnchorMatch>();
    if (threadAnchors.size === 0) {
      setAnchorMatch((prev) => (prev.size === 0 ? prev : newMatch));
      return;
    }

    const blockEls = Array.from(
      root.querySelectorAll<HTMLElement>("[data-line-start]"),
    );

    for (const t of threadsForFile) {
      const anchor = threadAnchors.get(t.id);
      if (!anchor) continue;
      const end = t.line ?? t.originalLine ?? 0;
      if (!end) continue;
      const start = t.startLine ?? end;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (const expand of [0, 2]) {
        const blocks = blockEls.filter((el) => {
          if (skipBlocks.has(el)) return false;
          const s = parseInt(el.dataset.lineStart!, 10);
          const e = parseInt(el.dataset.lineEnd!, 10);
          return e >= lo - expand && s <= hi + expand;
        });
        if (!blocks.length) continue;
        const found = findAnchorRange(blocks, anchor);
        if (!found) continue;
        const range = document.createRange();
        try {
          range.setStart(found.startNode, found.startOffset);
          range.setEnd(found.endNode, found.endOffset);
          const mark = document.createElement("mark");
          mark.className = `word-anchor ${t.isResolved ? "resolved" : ""} ${
            found.match === "recovered" ? "recovered" : ""
          }`;
          mark.dataset.threadId = t.id;
          try {
            range.surroundContents(mark);
          } catch {
            const frag = range.extractContents();
            mark.appendChild(frag);
            range.insertNode(mark);
          }
          newMatch.set(t.id, expand > 0 ? "recovered" : found.match);
          break;
        } catch {
          // skip
        }
      }
      if (!newMatch.has(t.id)) {
        newMatch.set(t.id, "stale");
      }
    }
    setAnchorMatch(newMatch);
  }, [threadAnchors, threadsForFile, fileContent]);

  // Apply active class to currently-highlighted anchor
  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    root.querySelectorAll("mark.word-anchor").forEach((m) => {
      m.classList.toggle(
        "active",
        (m as HTMLElement).dataset.threadId === highlightedThread,
      );
    });
  }, [highlightedThread, anchorMatch]);

  // Map source line → threads covering that line (using startLine..line range)
  const threadsByLine = useMemo(() => {
    const m = new Map<number, ReviewThread[]>();
    for (const t of threadsForFile) {
      const end = t.line ?? t.originalLine ?? 0;
      if (!end) continue;
      const start = t.startLine ?? end;
      for (let l = Math.min(start, end); l <= Math.max(start, end); l++) {
        if (!m.has(l)) m.set(l, []);
        m.get(l)!.push(t);
      }
    }
    return m;
  }, [threadsForFile]);

  // Most recent comment from someone other than the current user
  const peerActivity = useMemo(() => {
    let latest: { thread: ReviewThread; comment: ReviewComment } | null = null;
    for (const t of threads) {
      if (t.path !== activeFile) continue;
      for (const c of t.comments.nodes) {
        if (currentUser && c.author?.login === currentUser) continue;
        if (!latest || c.createdAt > latest.comment.createdAt) {
          latest = { thread: t, comment: c };
        }
      }
    }
    return latest;
  }, [threads, activeFile, currentUser]);

  // Position the peer activity chip in the prose gutter
  useEffect(() => {
    if (!peerActivity || !proseRef.current) {
      setPeterChipTop(null);
      return;
    }
    const ln = peerActivity.thread.line ?? peerActivity.thread.originalLine;
    if (!ln) return;
    const els = proseRef.current.querySelectorAll<HTMLElement>("[data-line-start]");
    for (const el of Array.from(els)) {
      const s = parseInt(el.dataset.lineStart!, 10);
      const e = parseInt(el.dataset.lineEnd!, 10);
      if (s <= ln && e >= ln) {
        const proseRect = proseRef.current.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        setPeterChipTop(elRect.top - proseRect.top + proseRef.current.scrollTop);
        return;
      }
    }
    setPeterChipTop(null);
  }, [peerActivity, fileContent, threads]);

  const scrollToLine = useCallback((line: number) => {
    if (!proseRef.current) return;
    const els = proseRef.current.querySelectorAll<HTMLElement>("[data-line-start]");
    let target: HTMLElement | null = null;
    for (const el of Array.from(els)) {
      const s = parseInt(el.dataset.lineStart!, 10);
      const e = parseInt(el.dataset.lineEnd!, 10);
      if (s <= line && e >= line) {
        target = el;
        break;
      }
    }
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("flash");
      setTimeout(() => target!.classList.remove("flash"), 1200);
    }
  }, []);

  // mdComponents is intentionally stable — thread state never goes through
  // React render. This keeps ReactMarkdown from re-rendering blocks (and
  // dropping the user's text selection) when threads update from polling.
  const mdComponents = useMemo(() => {
    const lineProps = (node: any): Record<string, any> => {
      const start = node?.position?.start?.line;
      const end = node?.position?.end?.line;
      if (!start) return {};
      return { "data-line-start": start, "data-line-end": end ?? start };
    };
    const wrap = (Tag: any) => (props: any) => {
      const { node, children, ...rest } = props;
      return (
        <Tag {...rest} {...lineProps(node)}>
          {children}
        </Tag>
      );
    };
    return {
      p: wrap("p"),
      h1: wrap("h1"),
      h2: wrap("h2"),
      h3: wrap("h3"),
      h4: wrap("h4"),
      h5: wrap("h5"),
      h6: wrap("h6"),
      blockquote: wrap("blockquote"),
      li: wrap("li"),
      pre: wrap("pre"),
      hr: wrap("hr"),
    };
  }, []);

  // Apply has-thread / thread-active / thread-resolved classes via direct DOM
  // mutation rather than re-rendering blocks.
  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    const blocks = root.querySelectorAll<HTMLElement>("[data-line-start]");
    for (const block of Array.from(blocks)) {
      const ln = parseInt(block.dataset.lineStart!, 10);
      const lnEnd = parseInt(block.dataset.lineEnd!, 10);
      let unresolvedCount = 0;
      let activeIsResolved: boolean | null = null;
      let activePresent = false;
      for (const [k, ts] of threadsByLine) {
        if (k < ln || k > lnEnd) continue;
        for (const t of ts) {
          if (!t.isResolved) unresolvedCount++;
          if (highlightedThread && t.id === highlightedThread) {
            activePresent = true;
            activeIsResolved = t.isResolved;
          }
        }
      }
      const showHighlight = unresolvedCount > 0 || activePresent;
      block.classList.toggle("has-thread", showHighlight);
      block.classList.toggle("thread-active", activePresent);
      block.classList.toggle("thread-resolved", activeIsResolved === true);
    }
  }, [threadsByLine, highlightedThread, fileContent]);

  // Delegated click handler on the prose. Reads latest state via ref so the
  // listener itself stays attached for the document's lifetime.
  const proseClickStateRef = useRef({ threadsByLine, highlightedThread, flashThread });
  useEffect(() => {
    proseClickStateRef.current = { threadsByLine, highlightedThread, flashThread };
  }, [threadsByLine, highlightedThread, flashThread]);
  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      const tgt = e.target as HTMLElement | null;
      const block = tgt?.closest("[data-line-start]") as HTMLElement | null;
      if (!block || !root.contains(block)) return;
      const { threadsByLine: tbl, highlightedThread: ht, flashThread: ft } =
        proseClickStateRef.current;
      const ln = parseInt(block.dataset.lineStart!, 10);
      const lnEnd = parseInt(block.dataset.lineEnd!, 10);
      const blockThreads: ReviewThread[] = [];
      for (const [k, ts] of tbl) {
        if (k >= ln && k <= lnEnd) blockThreads.push(...ts);
      }
      if (!blockThreads.length) return;
      const unresolved = blockThreads.filter((t) => !t.isResolved);
      const activeThread = ht ? blockThreads.find((t) => t.id === ht) : undefined;
      const markEl = tgt?.closest("mark.word-anchor") as HTMLElement | null;
      const targetId =
        markEl?.dataset.threadId ?? unresolved[0]?.id ?? activeThread?.id;
      if (!targetId) return;
      const target = blockThreads.find((t) => t.id === targetId);
      if (!target) return;
      e.stopPropagation();
      if (activeThread && activeThread.id === target.id) {
        setHighlightedThread(null);
      } else {
        ft(target.id);
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="icon-btn"
          onClick={() => setSidebarHidden((v) => !v)}
          title={sidebarHidden ? "Show PR list" : "Hide PR list"}
          aria-label="Toggle PR sidebar"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              fill="currentColor"
              d="M2 3h12v1H2V3zm0 4h12v1H2V7zm0 4h12v1H2v-1z"
            />
          </svg>
        </button>
        <input
          className="repo-input"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onBlur={() => loadPRs(false)}
          spellCheck={false}
        />
        <button onClick={() => loadPRs(true)} disabled={loading}>
          {loading ? "..." : "Refresh"}
        </button>
        {selectedPR && (
          <span className="pr-meta">
            #{selectedPR.number} · {selectedPR.headRefName} → {selectedPR.baseRefName}
          </span>
        )}
        {peerActivity && (
          <button
            className={`activity-chip ${activityFreshness(peerActivity.comment.createdAt)}`}
            onClick={() => {
              const ln = peerActivity.thread.line ?? peerActivity.thread.originalLine;
              flashThread(peerActivity.thread.id);
              if (ln) scrollToLine(ln);
            }}
            title={`Latest from ${peerActivity.comment.author.login}`}
          >
            <span className="avatar">
              {peerActivity.comment.author.login[0]?.toUpperCase()}
            </span>
            {peerActivity.comment.author.login} · L
            {peerActivity.thread.line ?? peerActivity.thread.originalLine} ·{" "}
            {relativeTime(peerActivity.comment.createdAt)}
          </button>
        )}
        {err && <span className="err" title={err}>{err.slice(0, 120)}</span>}
      </header>

      <div
        className={`layout ${sidebarHidden ? "no-sidebar" : ""}`}
        style={{ ["--threads-width" as any]: `${threadsWidth}px` }}
      >
        {!sidebarHidden && (
        <aside className="sidebar">
          <input
            className="filter"
            placeholder="Filter PRs"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ul className="pr-list">
            {filteredPRs.map((p) => (
              <li
                key={p.number}
                className={selectedPR?.number === p.number ? "active" : ""}
                onClick={() => openPR(p.number)}
              >
                <div className="pr-title">#{p.number} {p.title}</div>
                <div className="pr-sub">
                  {p.headRefName} · {new Date(p.updatedAt).toLocaleDateString()}
                </div>
              </li>
            ))}
            {!filteredPRs.length && !loading && <li className="empty">No PRs</li>}
          </ul>
        </aside>
        )}

        <main className="main">
          {selectedPR && (
            <div className="file-tabs">
              {filesSorted.map((f) => (
                <button
                  key={f.path}
                  className={f.path === activeFile ? "active" : ""}
                  onClick={() => switchFile(f.path)}
                  title={f.path}
                >
                  <span>{f.path.split("/").pop()}</span>
                  {f.unresolved > 0 && (
                    <span className="file-badge" title={`${f.unresolved} unresolved`}>
                      {f.unresolved}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="prose" ref={proseRef} onMouseUp={onMouseUp}>
            {peterChipTop !== null && peerActivity && (
              <button
                className={`gutter-chip ${activityFreshness(peerActivity.comment.createdAt)}`}
                style={{ top: peterChipTop }}
                onClick={() => {
                  flashThread(peerActivity.thread.id);
                }}
                title={`${peerActivity.comment.author.login} · ${relativeTime(peerActivity.comment.createdAt)}`}
              >
                <span className="avatar">
                  {peerActivity.comment.author.login[0]?.toUpperCase()}
                </span>
              </button>
            )}
            {fileContent ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents as any}>
                {fileContent}
              </ReactMarkdown>
            ) : selectedPR ? (
              <div className="empty-prose">Select a file</div>
            ) : (
              <div className="empty-prose">Select a PR from the sidebar</div>
            )}
          </div>

          {selRange && !composerOpen && (
            <div className="sel-toolbar">
              <span className="sel-label">
                {selAnchor ? (
                  <>
                    <span className="sel-quote">"{truncate(selAnchor.exact, 28)}"</span>
                    <span className="sel-line">L{selRange.end}</span>
                  </>
                ) : (
                  <span className="sel-line">
                    Lines {selRange.start}
                    {selRange.end !== selRange.start ? `-${selRange.end}` : ""}
                  </span>
                )}
              </span>
              <button className="primary" onClick={() => setComposerOpen(true)}>
                + Comment<kbd>c</kbd>
              </button>
              <button
                onClick={() => {
                  setSelRange(null);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {composerOpen && selRange && (
            <div className="composer">
              <div className="composer-header">
                {selAnchor ? (
                  <>
                    Commenting on <span className="anchor-pill">"{truncate(selAnchor.exact, 60)}"</span>{" "}
                    <span className="composer-line">L{selRange.end}</span>
                  </>
                ) : (
                  <>
                    Comment on lines {selRange.start}
                    {selRange.end !== selRange.start ? `-${selRange.end}` : ""}
                  </>
                )}
              </div>
              <textarea
                autoFocus
                value={composerBody}
                onChange={(e) => setComposerBody(e.target.value)}
                placeholder="Leave a comment (Cmd+Enter to submit)"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitComment();
                  }
                  if (e.key === "Escape") setComposerOpen(false);
                }}
              />
              <div className="composer-actions">
                <button onClick={() => setComposerOpen(false)}>Cancel</button>
                <button
                  className="primary"
                  onClick={submitComment}
                  disabled={!composerBody.trim() || loading}
                >
                  Comment
                </button>
              </div>
            </div>
          )}
        </main>

        <div
          className="resizer"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
        />
        <aside className="threads">
          <div className="threads-header">
            <span>Threads ({threadsForFile.length})</span>
            <button onClick={refreshThreads} disabled={!selectedPR}>↻</button>
          </div>
          <ul className="thread-list">
            {threadsForFile
              .slice()
              .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
              .map((t) => (
                <ThreadCard
                  key={t.id}
                  thread={t}
                  anchor={threadAnchors.get(t.id) ?? null}
                  matchState={anchorMatch.get(t.id) ?? null}
                  currentUser={currentUser}
                  highlighted={highlightedThread === t.id}
                  isNew={newThreadIds.has(t.id)}
                  registerEl={(el) => registerThreadEl(t.id, el)}
                  onDelete={(id) => deleteComment(id)}
                  onActivate={() => {
                    if (highlightedThread === t.id) {
                      setHighlightedThread(null);
                      return;
                    }
                    const ln = t.line ?? t.originalLine;
                    setHighlightedThread(t.id);
                    if (ln) scrollToLine(ln);
                  }}
                  onResolve={() => toggleResolve(t)}
                  onReply={(body) => replyTo(t, body)}
                />
              ))}
            {!threadsForFile.length && (
              <li className="empty">No threads on this file</li>
            )}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function ThreadCard({
  thread,
  anchor,
  matchState,
  currentUser,
  highlighted,
  isNew,
  registerEl,
  onActivate,
  onResolve,
  onReply,
  onDelete,
}: {
  thread: ReviewThread;
  anchor: Anchor | null;
  matchState: AnchorMatch | null;
  currentUser: string | null;
  highlighted: boolean;
  isNew: boolean;
  registerEl: (el: HTMLElement | null) => void;
  onActivate: () => void;
  onResolve: () => void;
  onReply: (body: string) => void;
  onDelete: (commentId: number) => void;
}) {
  const [reply, setReply] = useState("");
  const [open, setOpen] = useState(false);
  const ln = thread.line ?? thread.originalLine ?? "?";
  return (
    <li
      ref={registerEl}
      className={`thread ${thread.isResolved ? "resolved" : ""} ${highlighted ? "highlighted" : ""} ${isNew ? "is-new" : ""}`}
      onClick={onActivate}
    >
      <div className="thread-meta">
        <span className="line-btn">L{ln}</span>
        <span className="status">
          {thread.isResolved ? "resolved" : thread.isOutdated ? "outdated" : "open"}
        </span>
        {thread.pendingOp && <span className="pending-pill">saving…</span>}
        <button
          className="resolve-btn"
          onClick={(e) => {
            e.stopPropagation();
            onResolve();
          }}
        >
          {thread.isResolved ? "Unresolve" : "Resolve"}
        </button>
      </div>
      {anchor && (
        <div className={`anchor-row ${matchState ?? ""}`}>
          <span className="anchor-pill">"{truncate(anchor.exact, 80)}"</span>
          {matchState === "recovered" && (
            <span className="anchor-badge recovered" title="Anchor recovered nearby">
              recovered
            </span>
          )}
          {matchState === "stale" && (
            <span className="anchor-badge stale" title="Anchor text not found in source">
              stale
            </span>
          )}
        </div>
      )}
      <ul className="comments">
        {thread.comments.nodes.map((c, idx) => {
          const isMine = currentUser !== null && c.author?.login === currentUser;
          return (
            <li key={c.id}>
              <div className="comment-author">
                <span>
                  {c.author?.login} · {new Date(c.createdAt).toLocaleString()}
                </span>
                {isMine && (
                  <DeleteButton onConfirm={() => onDelete(c.databaseId)} />
                )}
              </div>
              <div className="comment-body">
                {idx === 0 ? stripAnchorFromBody(c.body) : c.body}
              </div>
            </li>
          );
        })}
      </ul>
      {open ? (
        <div className="reply" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply..."
            autoFocus
          />
          <div className="reply-actions">
            <button onClick={() => { setOpen(false); setReply(""); }}>Cancel</button>
            <button
              className="primary"
              disabled={!reply.trim()}
              onClick={() => {
                onReply(reply);
                setReply("");
                setOpen(false);
              }}
            >
              Reply
            </button>
          </div>
        </div>
      ) : (
        <button
          className="reply-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          Reply
        </button>
      )}
    </li>
  );
}

function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      className={`trash-btn ${armed ? "armed" : ""}`}
      title={armed ? "Click again to confirm" : "Delete comment"}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      aria-label={armed ? "Confirm delete" : "Delete comment"}
    >
      {armed ? (
        <span className="trash-confirm">Delete?</span>
      ) : (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            fill="currentColor"
            d="M5.5 1.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5V2h3a.5.5 0 0 1 0 1h-.62l-.7 10.43A2 2 0 0 1 10.18 15H5.82a2 2 0 0 1-2-1.57L3.12 3H2.5a.5.5 0 0 1 0-1h3v-.5zm1 .5V2h3v-.5h-3zM4.13 3l.69 10.29a1 1 0 0 0 1 .71h4.36a1 1 0 0 0 1-.71L11.87 3H4.13zM6.5 5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 .5-.5zm3 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 .5-.5z"
          />
        </svg>
      )}
    </button>
  );
}

export default App;
