import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { MarginRail } from "./MarginRail";
import {
  buildCommentBody,
  captureAnchorFromRange,
  findAnchorRange,
  parseAnchor,
  type Anchor,
  type AnchorMatch,
} from "./anchors";
import type { PR, PRSummary, ReviewComment, ReviewThread } from "./types";
import "./App.css";

const SHOW_RESOLVED_KEY = "nr.showResolved";
const THREADS_WIDTH_KEY = "nr.threadsWidth";
// The repo is hard-coded for now: this app is a single-team review tool.
// If we ever ship to multiple teams, lift this back to user-configurable.
const REPO = "SmartPass-Book/book";
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
  const repo = REPO;
  const [prs, setPRs] = useState<PRSummary[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedPR, setSelectedPR] = useState<PR | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selRange, setSelRange] = useState<LineRange | null>(null);
  const [selAnchor, setSelAnchor] = useState<Anchor | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerBody, setComposerBody] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [anchorMatch, setAnchorMatch] = useState<Map<string, AnchorMatch>>(
    new Map(),
  );
  const [highlightedThread, setHighlightedThread] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [newThreadIds, setNewThreadIds] = useState<Set<string>>(new Set());
  const [collaboratorChipTop, setCollaboratorChipTop] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  const [showResolved, setShowResolved] = useState<boolean>(
    () => localStorage.getItem(SHOW_RESOLVED_KEY) === "1",
  );
  const [threadsWidth] = useState<number>(() => {
    const v = parseInt(localStorage.getItem(THREADS_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(v) && v >= MIN_THREADS_WIDTH && v <= MAX_THREADS_WIDTH
      ? v
      : DEFAULT_THREADS_WIDTH;
  });
  const proseRef = useRef<HTMLDivElement>(null);
  // Live preview mark wrapping the current text selection while the composer
  // is open. The browser's native selection highlight disappears the moment
  // focus moves to the composer's textarea, so we paint a real DOM mark as
  // a stand-in. Cleared on submit / cancel / Esc / click-outside.
  const previewMarkRef = useRef<HTMLElement | null>(null);

  // Unwrap any <mark.word-anchor> we've inserted before letting React reconcile
  // the markdown subtree. Necessary whenever fileContent is about to change:
  // React diffs its rendered children against its VDOM, but our marks are not
  // in the VDOM, so without this it tries to update text nodes that have been
  // moved into a <mark> wrapper and crashes with NotFoundError.
  const unwrapMarks = useCallback(() => {
    const root = proseRef.current;
    if (!root) return;
    const touched = new Set<HTMLElement>();
    root.querySelectorAll("mark.word-anchor").forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      const block = (m as HTMLElement).closest("[data-line-start]") as HTMLElement | null;
      if (block) touched.add(block);
    });
    touched.forEach((b) => b.normalize());
  }, []);

  // Wrap the user's current Range in a <mark> so the highlight stays visible
  // after focus moves to the composer's textarea. Stash the element on the
  // ref so we can find it again on close.
  const paintPreviewMark = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const mark = document.createElement("mark");
    mark.className = "word-anchor preview-anchor";
    try {
      range.surroundContents(mark);
    } catch {
      // Cross-element range: surroundContents throws. Same fallback as the
      // post-render anchor walker - extract + insert.
      try {
        const frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
      } catch {
        return;
      }
    }
    previewMarkRef.current = mark;
    sel.removeAllRanges();
  }, []);

  const clearPreviewMark = useCallback(() => {
    const m = previewMarkRef.current;
    if (!m) return;
    const parent = m.parentNode;
    if (parent) {
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      const block = m.closest("[data-line-start]") as HTMLElement | null;
      if (block) block.normalize();
    }
    previewMarkRef.current = null;
  }, []);

  const proseGridRef = useRef<HTMLDivElement>(null);
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
    localStorage.setItem(SHOW_RESOLVED_KEY, showResolved ? "1" : "0");
  }, [showResolved]);

  useEffect(() => {
    localStorage.setItem(THREADS_WIDTH_KEY, String(threadsWidth));
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

  // Mirror the Rust-side `gh_log!` / `sync_log!` output into the dev tools
  // console. Without this, those lines only show up on stderr (i.e. only
  // visible if you launched the app from a terminal).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("log://line", (ev) => {
      // Tag with a leading marker so it's easy to filter the console.
      console.log("%c[rust]%c " + ev.payload, "color:#c08a00;font-weight:bold", "");
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

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
  // Re-fetch PR + file content when the poll loop detects the PR's head SHA
  // moved (commits pushed). Without this, threads on the new commit anchor
  // against stale file content and show as STALE.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ repo: string; number: number; headRefOid: string }>(
      "cache:pr-updated",
      async (ev) => {
        if (!selectedPR) return;
        if (ev.payload.repo !== repo || ev.payload.number !== selectedPR.number) return;
        if (ev.payload.headRefOid === selectedPR.headRefOid) return;
        try {
          const pr = await api.getPR(repo, selectedPR.number);
          setSelectedPR(pr);
          if (activeFile) {
            const content = await api.getFile(repo, pr.headRefOid, activeFile);
            unwrapMarks();
            setFileContent(content);
          }
        } catch {
          // ignore
        }
      },
    ).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [selectedPR, repo, activeFile]);

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

  // Read the current window selection inside the prose. Returns the line
  // range + word-anchor, or null if no usable selection. Used both on
  // mouseup (after a drag completes) and on `c` keypress (which may fire
  // mid-drag — we want to commit the selection then too).
  const captureSelection = useCallback((): {
    range: LineRange;
    anchor: Anchor | null;
  } | null => {
    const sel = window.getSelection();
    console.log("[captureSelection] sel=", sel, "isCollapsed=", sel?.isCollapsed, "rangeCount=", sel?.rangeCount, "text=", sel?.toString().slice(0, 40));
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      console.log("[captureSelection] bail: no/empty selection");
      return null;
    }
    const range = sel.getRangeAt(0);
    if (!proseRef.current?.contains(range.commonAncestorContainer)) {
      console.log("[captureSelection] bail: not inside prose. ancestor=", range.commonAncestorContainer);
      return null;
    }
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
      console.log("[captureSelection] bail: no line element. startEl=", startEl, "endEl=", endEl);
      return null;
    }
    const start = Math.min(
      parseInt(startEl.dataset.lineStart!, 10),
      parseInt(endEl.dataset.lineStart!, 10),
    );
    const end = Math.max(
      parseInt(startEl.dataset.lineEnd!, 10),
      parseInt(endEl.dataset.lineEnd!, 10),
    );
    const anchor = captureAnchorFromRange(range, proseRef.current);
    console.log("[captureSelection] OK", { start, end, anchor });
    return { range: { start, end }, anchor };
  }, []);

  // Click-outside-to-close for the composer. If you mousedown anywhere
  // that isn't inside the composer popover, dismiss it.
  useEffect(() => {
    if (!composerOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".composer")) return;
      setComposerOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [composerOpen]);

  // Single source of truth for clearing the live preview mark: any time the
  // composer transitions to closed (Esc, click-outside, Cancel, submit-fail
  // path), we drop the mark. submitComment also calls it directly so the
  // mark goes away the same frame as the optimistic insert.
  useEffect(() => {
    if (!composerOpen) clearPreviewMark();
  }, [composerOpen, clearPreviewMark]);

  // Click-outside-to-close for the PR-switcher dropdown. Dismiss unless the
  // mousedown lands inside either the trigger chip or the menu itself.
  useEffect(() => {
    if (!switcherOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".pr-switcher") || t.closest(".pr-switcher-menu")) return;
      setSwitcherOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [switcherOpen]);

  // Resolve the active text selection: prefer a live capture of the current
  // window selection (catches mid-drag keypresses), fall back to whatever
  // selRange we last stored. Used by every prose-level shortcut so each
  // shortcut behaves consistently whether triggered while still dragging or
  // after the drag ended.
  const resolveSelection = useCallback((): {
    range: LineRange;
    anchor: Anchor | null;
  } | null => {
    const captured = captureSelection();
    if (captured) {
      setSelRange(captured.range);
      setSelAnchor(captured.anchor);
      return captured;
    }
    if (selRange) return { range: selRange, anchor: selAnchor };
    return null;
  }, [captureSelection, selRange, selAnchor]);

  // Single source of truth for posting a review comment over a captured
  // range. Wraps `body` with the anchor metadata (so the marker survives a
  // round-trip through GitHub) and lets the optimistic-insert/outbox flow
  // handle the actual network write. `c` (composer) and `s` (strikethrough)
  // both go through this.
  const postCommentForRange = useCallback(
    async (range: LineRange, anchor: Anchor | null, body: string) => {
      if (!selectedPR || !activeFile) return;
      setErr(null);
      try {
        await api.mutatePostComment({
          repo,
          number: selectedPR.number,
          commitId: selectedPR.headRefOid,
          path: activeFile,
          line: range.end,
          startLine: range.start === range.end ? undefined : range.start,
          body: buildCommentBody(body, anchor),
        });
      } catch (e: any) {
        setErr(String(e));
      }
    },
    [activeFile, repo, selectedPR],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "Escape") {
        if (switcherOpen) {
          setSwitcherOpen(false);
          return;
        }
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
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (inField || composerOpen) return;

      if (e.key === "c") {
        const sel = resolveSelection();
        if (!sel) return;
        e.preventDefault();
        setComposerOpen(true);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selRange, composerOpen, switcherOpen, highlightedThread, resolveSelection]);

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
        unwrapMarks();
        setFileContent(content);
        setThreads(threadsList);
      } catch (e: any) {
        setErr(String(e));
      } finally {
        setLoading(false);
      }
    },
    [repo, unwrapMarks],
  );

  // Blow away the SQLite cache (PR list, PR detail, threads, comments, file
  // contents) and re-fetch from GitHub. Outbox is preserved so any in-flight
  // Stale-while-revalidate refresh of just the PR list. Fire-and-forget;
  // no spinner. Used when the user opens the PR-switcher dropdown - the
  // current `prs` array stays mounted so the menu renders instantly, and
  // the network result swaps in via setPRs when it lands.
  const refreshPRList = useCallback(async () => {
    try {
      const list = await api.refreshPRs(repo);
      setPRs(list);
    } catch (e: any) {
      setErr(String(e));
    }
  }, [repo]);

  // Refresh just the active PR: blow away its cache (threads, comments,
  // PR detail) and re-open. Other PRs in the local cache are untouched.
  // Outbox is preserved so any in-flight optimistic mutations still drain.
  // Wired to both Cmd/Ctrl+R and the refresh button in the topbar.
  const refreshActivePR = useCallback(async () => {
    if (!selectedPR) return;
    setRefreshing(true);
    try {
      await api.clearPrCache(repo, selectedPR.number);
      await openPR(selectedPR.number);
    } catch (err: any) {
      setErr(String(err));
    } finally {
      setRefreshing(false);
    }
  }, [openPR, repo, selectedPR]);

  useEffect(() => {
    const onReload = (e: KeyboardEvent) => {
      if (e.key !== "r" || !(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      e.preventDefault();
      void refreshActivePR();
    };
    window.addEventListener("keydown", onReload);
    return () => window.removeEventListener("keydown", onReload);
  }, [refreshActivePR]);

  const switchFile = useCallback(
    async (path: string) => {
      if (!selectedPR) return;
      setActiveFile(path);
      unwrapMarks();
      setFileContent("");
      try {
        const content = await api.getFile(repo, selectedPR.headRefOid, path);
        unwrapMarks();
        setFileContent(content);
      } catch (e: any) {
        setErr(String(e));
      }
    },
    [repo, selectedPR, unwrapMarks],
  );

  const onMouseUp = useCallback(() => {
    // If the user pressed `c` mid-drag the composer is already open with the
    // captured selection. Releasing the mouse moves the window selection into
    // the textarea (autoFocus), so a fresh captureSelection() would return
    // null and wipe selRange — which would unmount the composer. Skip mouseup
    // bookkeeping while the composer is up.
    if (composerOpen) return;
    const captured = captureSelection();
    if (!captured) {
      setSelRange(null);
      setSelAnchor(null);
      return;
    }
    setSelRange(captured.range);
    setSelAnchor(captured.anchor);
    // Paint the preview mark first, THEN open the composer. The composer's
    // autoFocus drops the native selection; the mark replaces it visually.
    paintPreviewMark();
    setComposerOpen(true);
  }, [captureSelection, composerOpen, paintPreviewMark]);

  const submitComment = useCallback(async () => {
    if (!selRange || !composerBody.trim()) return;
    try {
      await postCommentForRange(selRange, selAnchor, composerBody);
      setComposerBody("");
      setComposerOpen(false);
      setSelRange(null);
      setSelAnchor(null);
      clearPreviewMark();
      window.getSelection()?.removeAllRanges();
    } catch (e: any) {
      setErr(String(e));
    }
  }, [composerBody, selRange, selAnchor, postCommentForRange, clearPreviewMark]);

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
    () =>
      threads.filter(
        (t) => t.path === activeFile && (showResolved || !t.isResolved),
      ),
    [threads, activeFile, showResolved],
  );

  // Count of resolved threads on the current file (for the toggle label).
  const resolvedCount = useMemo(
    () =>
      threads.filter((t) => t.path === activeFile && t.isResolved).length,
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
        // Bail on cross-block ranges. Multi-line GH comments produce anchors
        // whose `exact` spans multiple paragraphs; surrounding such a range
        // with a single <mark> would require surroundContents (throws when
        // the range crosses element boundaries) or extractContents, which
        // rips text out of each block and leaves empty/split <p> shells in
        // their place — visible as duplicate gutter line numbers and ghost
        // highlight bars. Skip the inline mark and let the block-level
        // .has-thread tint cover the multi-line range.
        const startBlock = (found.startNode.parentElement as HTMLElement | null)?.closest(
          "[data-line-start]",
        );
        const endBlock = (found.endNode.parentElement as HTMLElement | null)?.closest(
          "[data-line-start]",
        );
        if (startBlock !== endBlock) {
          newMatch.set(t.id, expand > 0 ? "recovered" : found.match);
          break;
        }
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
            // Within a single block, surroundContents may still fail (e.g.
            // range straddles an inline <em>). extractContents within one
            // parent only splits inline children, not the block, so it's
            // safe here.
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

  // Most recent comment from a collaborator (anyone other than the current user).
  const collaboratorActivity = useMemo(() => {
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

  // Position the collaborator activity chip in the prose gutter. .prose itself no
  // longer scrolls (its parent .prose-scroll does), so we just measure the
  // block's offset relative to .prose without any scrollTop adjustment.
  useEffect(() => {
    if (!collaboratorActivity || !proseRef.current) {
      setCollaboratorChipTop(null);
      return;
    }
    const ln = collaboratorActivity.thread.line ?? collaboratorActivity.thread.originalLine;
    if (!ln) return;
    const els = proseRef.current.querySelectorAll<HTMLElement>("[data-line-start]");
    for (const el of Array.from(els)) {
      const s = parseInt(el.dataset.lineStart!, 10);
      const e = parseInt(el.dataset.lineEnd!, 10);
      if (s <= ln && e >= ln) {
        const proseRect = proseRef.current.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        setCollaboratorChipTop(elRect.top - proseRect.top);
        return;
      }
    }
    setCollaboratorChipTop(null);
  }, [collaboratorActivity, fileContent, threads]);

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
          // If the thread has a successfully-placed inline anchor, the
          // <mark> already shows the highlight on the specific phrase. Skip
          // the block-level tint for this thread to avoid double-highlight.
          const m = anchorMatch.get(t.id);
          const hasInlineMark = m === "word" || m === "recovered";
          if (hasInlineMark) continue;
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
  }, [threadsByLine, highlightedThread, fileContent, anchorMatch]);

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
        <div className="pr-switcher-wrap">
          <button
            className="pr-switcher"
            onClick={() => {
              setSwitcherOpen((v) => {
                const next = !v;
                if (next) void refreshPRList();
                return next;
              });
            }}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
          >
            {selectedPR ? (
              <span className="pr-switcher-label">
                <span className="pr-switcher-num">#{selectedPR.number}</span>
                <span className="pr-switcher-branch">{selectedPR.headRefName}</span>
              </span>
            ) : (
              <span className="pr-switcher-label muted">Select a PR</span>
            )}
            <svg
              className="pr-switcher-chevron"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              aria-hidden="true"
            >
              <path fill="currentColor" d="M1 3l4 4 4-4z" />
            </svg>
          </button>
          {switcherOpen && (
            <div className="pr-switcher-menu" role="menu">
              <input
                className="filter"
                placeholder="Filter PRs"
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <ul className="pr-list">
                {filteredPRs.map((p) => (
                  <li
                    key={p.number}
                    role="menuitem"
                    className={selectedPR?.number === p.number ? "active" : ""}
                    onClick={() => {
                      openPR(p.number);
                      setSwitcherOpen(false);
                    }}
                  >
                    <div className="pr-title">#{p.number} {p.title}</div>
                    <div className="pr-sub">
                      {p.headRefName} · {new Date(p.updatedAt).toLocaleDateString()}
                    </div>
                  </li>
                ))}
                {!filteredPRs.length && !loading && (
                  <li className="empty">No PRs</li>
                )}
              </ul>
            </div>
          )}
        </div>
        {selectedPR && (
          <button
            className={`refresh-btn ${refreshing ? "spinning" : ""}`}
            title="Refresh this PR (Cmd+R)"
            aria-label="Refresh PR data"
            onClick={() => void refreshActivePR()}
            disabled={refreshing}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 3V1L4.5 4 8 7V5a3 3 0 1 1-3 3H3.5A4.5 4.5 0 1 0 8 3z"
              />
            </svg>
          </button>
        )}
        {selectedPR && (
          <span className="pr-meta">
            {selectedPR.headRefName} → {selectedPR.baseRefName}
          </span>
        )}
        {err && <span className="err" title={err}>{err.slice(0, 120)}</span>}
      </header>

      <div
        className="layout"
        style={{ ["--threads-width" as any]: `${threadsWidth}px` }}
      >
        <main className="main">
          {selectedPR && (
            <div className="file-tabs">
              <div className="file-tabs-list">
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
              <div className="file-tabs-aside">
                {resolvedCount > 0 && (
                  <button
                    className={`toggle-chip ${showResolved ? "on" : ""}`}
                    onClick={() => setShowResolved((v) => !v)}
                    title={showResolved ? "Hide resolved threads" : "Show resolved threads"}
                  >
                    <span className="check" aria-hidden="true">
                      {showResolved ? (
                        <svg viewBox="0 0 16 16" width="12" height="12">
                          <path
                            fill="currentColor"
                            d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"
                          />
                        </svg>
                      ) : null}
                    </span>
                    Show resolved ({resolvedCount})
                  </button>
                )}
                {collaboratorActivity && (
                  <button
                    className={`activity-chip ${activityFreshness(collaboratorActivity.comment.createdAt)}`}
                    onClick={() => {
                      const ln =
                        collaboratorActivity.thread.line ??
                        collaboratorActivity.thread.originalLine;
                      flashThread(collaboratorActivity.thread.id);
                      if (ln) scrollToLine(ln);
                    }}
                    title={`Latest from ${collaboratorActivity.comment.author.login}`}
                  >
                    <span className="avatar">
                      {collaboratorActivity.comment.author.login[0]?.toUpperCase()}
                    </span>
                    {collaboratorActivity.comment.author.login} · L
                    {collaboratorActivity.thread.line ??
                      collaboratorActivity.thread.originalLine}{" "}
                    · {relativeTime(collaboratorActivity.comment.createdAt)}
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="prose-scroll">
            <div className="prose-grid" ref={proseGridRef}>
              <div className="prose" ref={proseRef} onMouseUp={onMouseUp}>
                {collaboratorChipTop !== null && collaboratorActivity && (
                  <button
                    className={`gutter-chip ${activityFreshness(collaboratorActivity.comment.createdAt)}`}
                    style={{ top: collaboratorChipTop }}
                    onClick={() => {
                      flashThread(collaboratorActivity.thread.id);
                    }}
                    title={`${collaboratorActivity.comment.author.login} · ${relativeTime(collaboratorActivity.comment.createdAt)}`}
                  >
                    <span className="avatar">
                      {collaboratorActivity.comment.author.login[0]?.toUpperCase()}
                    </span>
                  </button>
                )}
                {fileContent ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents as any}>
                    {fileContent}
                  </ReactMarkdown>
                ) : selectedPR ? (
                  <div className="empty-prose">Select a file</div>
                ) : prs.length === 0 ? (
                  <div className="welcome">
                    <h2>No open PRs</h2>
                    <p className="welcome-sub">
                      Nothing in {repo} right now. Pull to refresh.
                    </p>
                    <button
                      className={`welcome-refresh ${refreshing ? "spinning" : ""}`}
                      onClick={async () => {
                        setRefreshing(true);
                        try {
                          await refreshPRList();
                        } finally {
                          setRefreshing(false);
                        }
                      }}
                      disabled={refreshing}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        aria-hidden="true"
                      >
                        <path
                          fill="currentColor"
                          d="M8 3V1L4.5 4 8 7V5a3 3 0 1 1-3 3H3.5A4.5 4.5 0 1 0 8 3z"
                        />
                      </svg>
                      Refresh
                    </button>
                  </div>
                ) : (
                  <div className="welcome">
                    <h2>Select a PR</h2>
                    <ul className="welcome-pr-list">
                      {prs.map((p) => (
                        <li key={p.number} onClick={() => openPR(p.number)}>
                          <div className="pr-title">
                            #{p.number} {p.title}
                          </div>
                          <div className="pr-sub">
                            {p.headRefName} ·{" "}
                            {new Date(p.updatedAt).toLocaleDateString()}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <MarginRail
                threadsForFile={threadsForFile}
                threadAnchors={threadAnchors}
                anchorMatch={anchorMatch}
                currentUser={currentUser}
                highlightedThread={highlightedThread}
                newThreadIds={newThreadIds}
                proseRef={proseRef}
                proseGridRef={proseGridRef}
                registerThreadEl={registerThreadEl}
                fileContent={fileContent}
                onActivate={(t) => {
                  if (highlightedThread === t.id) {
                    setHighlightedThread(null);
                    return;
                  }
                  flashThread(t.id);
                }}
                onResolve={(t) => toggleResolve(t)}
                onReply={(t, body) => replyTo(t, body)}
                onDelete={(commentId) => deleteComment(commentId)}
              />
            </div>
          </div>

          {composerOpen && selRange && (
            <div className="composer">
              <div className="composer-header">
                {selAnchor ? (
                  <>
                    Commenting on <span className="anchor-pill">{truncate(selAnchor.exact, 60)}</span>{" "}
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
                placeholder="Leave a comment"
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
                  <kbd className="kbd-inline" aria-label="Cmd+Enter">⌘⏎</kbd>
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
