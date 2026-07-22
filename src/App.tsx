import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
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
import { Toasts, type Toast } from "./Toasts";
import { SettingsMenu, type ToggleSetting } from "./Settings";
import "./App.css";

const SHOW_RESOLVED_KEY = "nr.showResolved";
const THREADS_WIDTH_KEY = "nr.threadsWidth";
const AUTO_COMPOSER_KEY = "nr.autoComposer";
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

// Turn a raw octocrab/GitHub error string into something a reviewer can act
// on. The common case by far is a 422 for a line that isn't part of the PR's
// diff - Prose lets you select any paragraph in the file, but GitHub only
// accepts review comments on changed lines plus a few lines of context.
function friendlyOutboxError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("422") || s.includes("unprocessable")) {
    if (s.includes("line") || s.includes("diff") || s.includes("position")) {
      return "GitHub rejected the line: review comments can only go on lines that are part of this PR's diff.";
    }
    return "GitHub rejected the request as invalid.";
  }
  if (s.includes("401") || s.includes("bad credentials")) {
    return "GitHub rejected the credentials. Try `gh auth login` and retry.";
  }
  if (s.includes("403") || s.includes("rate limit")) {
    return "GitHub refused the request (permissions or rate limit).";
  }
  if (s.includes("404")) {
    return "GitHub couldn't find the PR or commit - it may have been force-pushed.";
  }
  if (s.includes("timed out") || s.includes("timeout") || s.includes("dns") || s.includes("connect")) {
    return "Couldn't reach GitHub.";
  }
  return raw.length > 160 ? raw.slice(0, 159) + "…" : raw;
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
      if (
        ca[j].id !== cb[j].id ||
        ca[j].body !== cb[j].body ||
        (ca[j].pendingOp ?? null) !== (cb[j].pendingOp ?? null)
      ) return false;
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
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Monotonic counter for toast ids: two failures in the same millisecond
  // would otherwise collide on a timestamp-based id and React would drop one.
  const toastSeq = useRef(0);
  const [selRange, setSelRange] = useState<LineRange | null>(null);
  const [selAnchor, setSelAnchor] = useState<Anchor | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerBody, setComposerBody] = useState("");
  // Floating "leave a comment" cue button position, in coordinates relative
  // to the .prose container. Set on mouseup when there's a usable selection;
  // cleared when the composer opens or the selection is dropped. Stored as
  // `null` (rather than always rendered conditionally on selRange) so a stale
  // selRange after submit/Esc doesn't resurrect a button.
  const [composerCue, setComposerCue] = useState<{ top: number; left: number } | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [anchorMatch, setAnchorMatch] = useState<Map<string, AnchorMatch>>(
    new Map(),
  );
  const [highlightedThread, setHighlightedThread] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [collaboratorChipTop, setCollaboratorChipTop] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [showResolved, setShowResolved] = useState<boolean>(
    () => localStorage.getItem(SHOW_RESOLVED_KEY) === "1",
  );
  // Open the composer the moment a selection is made, instead of waiting for
  // the cue button or `c`. Defaults on; turn it off when you want to select
  // text just to read or copy it. Absent key means never set, hence the
  // !== "0" test rather than === "1".
  const [autoComposer, setAutoComposer] = useState<boolean>(
    () => localStorage.getItem(AUTO_COMPOSER_KEY) !== "0",
  );
  const [threadsWidth] = useState<number>(() => {
    const v = parseInt(localStorage.getItem(THREADS_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(v) && v >= MIN_THREADS_WIDTH && v <= MAX_THREADS_WIDTH
      ? v
      : DEFAULT_THREADS_WIDTH;
  });
  const dismissToast = useCallback((id: string) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = `t${++toastSeq.current}`;
    setToasts((ts) => [...ts, { ...t, id }]);
    return id;
  }, []);

  // Everything that used to call setErr(String(e)) now raises an error
  // toast. Errors were previously rendered as a truncated string in the
  // topbar, which was easy to miss entirely.
  const reportError = useCallback(
    (e: unknown, title = "Something went wrong") => {
      pushToast({
        kind: "error",
        title,
        detail: String(e),
        timeoutMs: 8000,
      });
    },
    [pushToast],
  );

  const proseRef = useRef<HTMLDivElement>(null);
  // Live preview marks wrapping the current text selection while the composer
  // is open. The browser's native selection highlight disappears the moment
  // focus moves to the composer's textarea, so we paint real DOM marks as
  // a stand-in - one per text-node segment, so no mark ever crosses an
  // element boundary. Cleared on submit / cancel / Esc / click-outside.
  const previewMarksRef = useRef<HTMLElement[]>([]);

  // In-file search (Cmd+F).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchCurrentIndex, setSearchCurrentIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchMatchesRef = useRef<HTMLElement[]>([]);

  // Unwrap any <mark.comment-highlight> we've inserted before letting React reconcile
  // the markdown subtree. Necessary whenever fileContent is about to change:
  // React diffs its rendered children against its VDOM, but our marks are not
  // in the VDOM, so without this it tries to update text nodes that have been
  // moved into a <mark> wrapper and crashes with NotFoundError.
  const unwrapMarks = useCallback(() => {
    const root = proseRef.current;
    if (!root) return;
    const touched = new Set<Node>();
    root.querySelectorAll("mark.comment-highlight, mark.search-match").forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      // Normalize the parent, captured before removal - closest() on the
      // now-detached mark would return null.
      touched.add(parent);
    });
    touched.forEach((p) => (p as Element).normalize?.());
  }, []);

  // Wrap the user's current selection in <mark>s so the highlight stays
  // visible after focus moves to the composer's textarea. One mark per
  // text-node segment: surroundContents/extractContents over a range that
  // crosses element boundaries splits those elements - for a cross-paragraph
  // selection it permanently splits the <p> blocks (duplicate gutter line
  // numbers, broken paragraphs that survive the composer closing). Per-node
  // marks only ever split a text node, which normalize() fully undoes.
  const paintPreviewMark = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);

    // Collect the text nodes the range touches before mutating anything.
    const ancestor = range.commonAncestorContainer;
    const textNodes: Text[] = [];
    if (ancestor.nodeType === Node.TEXT_NODE) {
      textNodes.push(ancestor as Text);
    } else {
      const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          range.intersectsNode(n)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      });
      let n: Node | null;
      while ((n = walker.nextNode())) textNodes.push(n as Text);
    }

    const marks: HTMLElement[] = [];
    for (const tn of textNodes) {
      const start = tn === range.startContainer ? range.startOffset : 0;
      const end = tn === range.endContainer ? range.endOffset : tn.data.length;
      if (start >= end) continue;
      // Whitespace-only segments (e.g. the newline text nodes between block
      // elements) would render as stray highlighted slivers - skip them.
      if (!tn.data.slice(start, end).trim()) continue;
      const r = document.createRange();
      r.setStart(tn, start);
      r.setEnd(tn, end);
      const mark = document.createElement("mark");
      mark.className = "comment-highlight preview-anchor";
      try {
        // Within a single text node this never throws.
        r.surroundContents(mark);
        marks.push(mark);
      } catch {
        // skip this segment
      }
    }
    if (!marks.length) return;
    previewMarksRef.current = marks;
    sel.removeAllRanges();
  }, []);

  // Compute a floating-cue anchor position from the current window selection,
  // in coordinates relative to the .prose container. Uses the LAST client
  // rect of the range so the button sits next to the end of the selection
  // (where the cursor came to rest after the drag), not at the far right of
  // a multi-line bounding box.
  const computeCuePos = useCallback((): { top: number; left: number } | null => {
    const prose = proseRef.current;
    if (!prose) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!prose.contains(range.commonAncestorContainer)) return null;
    const rects = range.getClientRects();
    const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    const proseRect = prose.getBoundingClientRect();
    return {
      top: last.top - proseRect.top + last.height / 2,
      left: last.right - proseRect.left + 6,
    };
  }, []);

  // Open the composer for the current selection. Used by both the floating
  // cue button and the `c` key. Paints the preview mark from the live window
  // selection (so the highlight survives the composer's autoFocus stealing
  // focus), then transitions to the composer-open state and hides the cue.
  const openComposer = useCallback(() => {
    paintPreviewMark();
    setComposerOpen(true);
    setComposerCue(null);
  }, [paintPreviewMark]);

  const clearPreviewMark = useCallback(() => {
    const marks = previewMarksRef.current;
    if (!marks.length) return;
    // Capture each mark's parent BEFORE removal - closest()/parentNode on a
    // detached node returns null, so normalizing afterwards would silently
    // no-op and leave split text nodes behind.
    const touched = new Set<Node>();
    for (const m of marks) {
      const parent = m.parentNode;
      if (!parent) continue; // already detached (e.g. content was swapped)
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      touched.add(parent);
    }
    touched.forEach((p) => (p as Element).normalize?.());
    previewMarksRef.current = [];
  }, []);

  const unwrapSearchMarks = useCallback(() => {
    const root = proseRef.current;
    if (!root) return;
    // Track each unwrapped mark's immediate parent - we must normalize() it so
    // the text nodes that flanked the mark merge back into one. Without that,
    // the next search walks split text nodes ("T" + "he…") and a multi-char
    // query like "Th" silently matches nothing.
    const touched = new Set<Node>();
    root.querySelectorAll("mark.search-match").forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      touched.add(parent);
    });
    touched.forEach((p) => (p as Element).normalize?.());
    searchMatchesRef.current = [];
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
    localStorage.setItem(AUTO_COMPOSER_KEY, autoComposer ? "1" : "0");
  }, [autoComposer]);

  useEffect(() => {
    localStorage.setItem(THREADS_WIDTH_KEY, String(threadsWidth));
  }, [threadsWidth]);

  const loadPRs = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const list = force ? await api.refreshPRs(repo) : await api.listPRs(repo);
        setPRs(list);
      } catch (e: any) {
        reportError(e, "Couldn't load pull requests");
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

  // A mutation exhausted its retries. The backend keeps the optimistic rows
  // (re-tagged `failed:<op-id>`) so the user's text is never destroyed; here
  // we surface the failure and offer the two recovery paths - retry the same
  // op, or discard it. Doing nothing is also safe: the failed card stays in
  // the rail until the user picks one.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ opId: string; kind: string; error: string; attempts: number }>(
      "outbox:failed",
      (ev) => {
        const { opId, kind, error } = ev.payload;
        const label =
          kind === "post_comment"
            ? "Comment"
            : kind === "reply"
              ? "Reply"
              : kind === "delete_comment"
                ? "Delete"
                : "Change";
        const recoverable = kind === "post_comment" || kind === "reply";
        pushToast({
          kind: "error",
          title: `${label} couldn't be saved to GitHub`,
          detail: recoverable
            ? `${friendlyOutboxError(error)} Your text is kept in the sidebar.`
            : friendlyOutboxError(error),
          actions: recoverable
            ? [
                {
                  label: "Retry",
                  primary: true,
                  onClick: () => {
                    void api.retryOutboxOp(opId).catch((e) => reportError(e));
                  },
                },
                {
                  label: "Discard",
                  onClick: () => {
                    void api.discardOutboxOp(opId).catch((e) => reportError(e));
                  },
                },
              ]
            : undefined,
          // No auto-dismiss: this needs a decision.
          timeoutMs: recoverable ? undefined : 10000,
        });
      },
    ).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [pushToast, reportError]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ repo: string; number: number }>("cache:threads-updated", async (ev) => {
      if (!selectedPR) return;
      if (ev.payload.repo !== repo || ev.payload.number !== selectedPR.number) return;
      try {
        const fetched = await api.getThreads(repo, selectedPR.number);
        setThreads((prev) => (threadsEqual(prev, fetched) ? prev : fetched));
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
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      return null;
    }
    const range = sel.getRangeAt(0);
    if (!proseRef.current?.contains(range.commonAncestorContainer)) {
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

  // The floating cue position is captured at mouseup time and is only valid
  // for the current selection in the current file. Drop it whenever the
  // composer takes over, the file changes, or the user navigates to a new PR
  // (its coordinates would otherwise point at stale layout).
  useEffect(() => {
    setComposerCue(null);
  }, [activeFile, selectedPR?.headRefOid, composerOpen]);

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

  // Same click-outside contract for the settings popover.
  useEffect(() => {
    if (!settingsOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".settings-wrap")) return;
      setSettingsOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [settingsOpen]);

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
        reportError(e, "Couldn't queue comment");
      }
    },
    [activeFile, repo, selectedPR, reportError],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "Escape") {
        if (searchOpen) {
          setSearchOpen(false);
          setSearchQuery("");
          return;
        }
        if (switcherOpen) {
          setSwitcherOpen(false);
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (composerOpen) {
          setComposerOpen(false);
          return;
        }
        if (selRange) {
          setSelRange(null);
          setComposerCue(null);
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
        openComposer();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selRange, composerOpen, switcherOpen, settingsOpen, highlightedThread, searchOpen, resolveSelection, openComposer]);

  const openPR = useCallback(
    async (number: number, opts?: { preferFile?: string | null }) => {
      // Don't clear current state — keep old PR visible until new content is
      // ready, then atomic-swap. Avoids the empty-state flash when everything
      // is cached.
      setLoading(true);
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
        // If the caller passed in the file the user was already on (e.g.
        // refresh re-opens the same PR), keep them on it as long as it still
        // exists in the new file list. Otherwise fall back to the heuristic:
        // top of the sorted list (file with most unresolved comments), then
        // first .md, then first file.
        const preferred = opts?.preferFile
          ? sortedFiles.find((f) => f.path === opts.preferFile)
          : undefined;
        const initial =
          preferred ??
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
        // Surface the actual cache freshness, not "now". get_pr is cache-first
        // so the data we just rendered may have been fetched days ago. The
        // backend stores fetched_at on every put_pr.
        const fetchedAt = await api.getPRFetchedAt(repo, number);
        setLastRefreshAt(fetchedAt ? new Date(fetchedAt) : new Date());
      } catch (e: any) {
        reportError(e, `Couldn't open PR #${number}`);
      } finally {
        setLoading(false);
      }
    },
    [repo, unwrapMarks, reportError],
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
      reportError(e, "Couldn't refresh PR list");
    }
  }, [repo, reportError]);

  // Refresh just the active PR: blow away its cache (threads, comments,
  // PR detail) and re-open. Other PRs in the local cache are untouched.
  // Outbox is preserved so any in-flight optimistic mutations still drain.
  // Wired to both Cmd/Ctrl+R and the refresh button in the topbar.
  const refreshActivePR = useCallback(async () => {
    if (!selectedPR) return;
    setRefreshing(true);
    try {
      await api.clearPrCache(repo, selectedPR.number);
      // Stay on the file the user was viewing if it's still in the PR.
      await openPR(selectedPR.number, { preferFile: activeFile });
    } catch (err: any) {
      reportError(err, "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, [openPR, repo, selectedPR, activeFile, reportError]);

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

  // Cmd+F opens the in-file search bar; Cmd+G / Cmd+Shift+G step through
  // matches. preventDefault suppresses the webview's native Find UI so we
  // own this UX.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "f" && !e.shiftKey) {
        if (!activeFile) return;
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }
      if (k === "g") {
        if (!searchOpen || searchMatchCount === 0) return;
        e.preventDefault();
        setSearchCurrentIndex((i) => {
          const n = searchMatchCount;
          if (e.shiftKey) return (i - 1 + n) % n;
          return (i + 1) % n;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeFile, searchOpen, searchMatchCount]);

  // Walk text nodes inside the prose and wrap matches in <mark.search-match>.
  // Re-runs when the query, search-open state, or rendered file content
  // changes. Always unwraps prior search marks first so updates are clean.
  useEffect(() => {
    unwrapSearchMarks();
    if (!searchOpen) {
      setSearchMatchCount(0);
      setSearchCurrentIndex(-1);
      return;
    }
    const q = searchQuery;
    if (!q) {
      setSearchMatchCount(0);
      setSearchCurrentIndex(-1);
      return;
    }
    const root = proseRef.current;
    if (!root) return;
    const qLower = q.toLowerCase();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("mark.search-match")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes: Text[] = [];
    let n: Node | null = walker.nextNode();
    while (n) {
      textNodes.push(n as Text);
      n = walker.nextNode();
    }

    const matches: HTMLElement[] = [];
    for (const tn of textNodes) {
      const text = tn.nodeValue ?? "";
      if (!text) continue;
      const lower = text.toLowerCase();
      const segments: { start: number; end: number }[] = [];
      let from = 0;
      while (from <= lower.length) {
        const idx = lower.indexOf(qLower, from);
        if (idx === -1) break;
        segments.push({ start: idx, end: idx + qLower.length });
        from = idx + qLower.length;
      }
      if (!segments.length) continue;
      const parent = tn.parentNode;
      if (!parent) continue;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const seg of segments) {
        if (seg.start > cursor) {
          frag.appendChild(document.createTextNode(text.slice(cursor, seg.start)));
        }
        const mark = document.createElement("mark");
        mark.className = "search-match";
        mark.appendChild(document.createTextNode(text.slice(seg.start, seg.end)));
        frag.appendChild(mark);
        matches.push(mark);
        cursor = seg.end;
      }
      if (cursor < text.length) {
        frag.appendChild(document.createTextNode(text.slice(cursor)));
      }
      parent.replaceChild(frag, tn);
    }

    searchMatchesRef.current = matches;
    setSearchMatchCount(matches.length);
    setSearchCurrentIndex(matches.length > 0 ? 0 : -1);
  }, [searchOpen, searchQuery, fileContent, unwrapSearchMarks]);

  // Apply the .current class to the active match and scroll it into view.
  useEffect(() => {
    const matches = searchMatchesRef.current;
    matches.forEach((m, i) => {
      m.classList.toggle("current", i === searchCurrentIndex);
    });
    if (searchCurrentIndex >= 0 && searchCurrentIndex < matches.length) {
      matches[searchCurrentIndex].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [searchCurrentIndex, searchMatchCount]);

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
        reportError(e, "Couldn't load file");
      }
    },
    [repo, selectedPR, unwrapMarks, reportError],
  );

  const onMouseUp = useCallback(() => {
    // While the composer is up, mouseup events come from inside the textarea
    // (autoFocus) and elsewhere - they shouldn't disturb the captured
    // selRange that the composer is bound to.
    if (composerOpen) return;
    const captured = captureSelection();
    if (!captured) {
      setSelRange(null);
      setSelAnchor(null);
      setComposerCue(null);
      return;
    }
    setSelRange(captured.range);
    setSelAnchor(captured.anchor);
    if (autoComposer) {
      // Straight to the composer - it paints the preview mark from the live
      // selection and its textarea autoFocuses, so you can just start typing.
      openComposer();
      return;
    }
    // Leave the native selection alone so the user can still copy. Surface a
    // floating cue button instead, and only paint the preview mark / open the
    // composer when they explicitly click it (or press `c`).
    setComposerCue(computeCuePos());
  }, [captureSelection, composerOpen, computeCuePos, autoComposer, openComposer]);

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
      reportError(e, "Couldn't post comment");
    }
  }, [composerBody, selRange, selAnchor, postCommentForRange, clearPreviewMark, reportError]);

  const toggleResolve = useCallback(
    async (thread: ReviewThread) => {
      try {
        // Optimistic: backend flips local state + enqueues op + emits a
        // cache:threads-updated event we'll pick up to re-render.
        await api.mutateResolve(thread.id, !thread.isResolved);
      } catch (e: any) {
        reportError(e, "Couldn't update thread");
      }
    },
    [reportError],
  );

  const deleteComment = useCallback(
    async (commentId: number) => {
      try {
        await api.mutateDeleteComment(repo, commentId);
      } catch (e: any) {
        reportError(e, "Couldn't delete comment");
      }
    },
    [repo, reportError],
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
        reportError(e, "Couldn't queue reply");
      }
    },
    [repo, selectedPR, reportError],
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

  // Whether the current selection can be posted as a line-anchored comment.
  // Mirrors the backend decision in mutate_post_comment (GitHub only accepts a
  // line-anchored review comment on lines inside the diff) so the composer can
  // say up front which level the comment will land at.
  const selectionInDiff = useMemo(() => {
    if (!selRange || !activeFile || !selectedPR) return false;
    const ranges = selectedPR.files.find((f) => f.path === activeFile)?.commentable;
    if (!ranges) return false;
    const lo = Math.min(selRange.start, selRange.end);
    const hi = Math.max(selRange.start, selRange.end);
    return ranges.some(([s, e]) => lo >= s && hi <= e);
  }, [selRange, activeFile, selectedPR]);

  // Declarative settings list rendered by the settings popover. Add a new
  // entry here (plus its state + localStorage effect) to add a setting.
  const appSettings = useMemo<ToggleSetting[]>(
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
    ],
    [autoComposer, showResolved],
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
      if (a) m.set(t.clientKey, a);
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

    // Unwrap existing marks (only in non-skipped blocks). Leave the
    // composer's live preview marks alone - they're cleared on composer
    // close, not by thread updates.
    const touched = new Set<HTMLElement>();
    root.querySelectorAll("mark.comment-highlight:not(.preview-anchor)").forEach((m) => {
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

    const searchable = blockEls.filter((el) => !skipBlocks.has(el));

    for (const t of threadsForFile) {
      const anchor = threadAnchors.get(t.clientKey);
      if (!anchor) continue;
      const end = t.line ?? t.originalLine ?? 0;
      // File-level threads (posted with subject_type: file because the
      // selection sat outside the diff) carry no line at all, so the anchor
      // text is the only position we have: search the whole document. A hit
      // there is the canonical match, not a degraded one - there was never a
      // line to drift from.
      const windows: HTMLElement[][] = end
        ? [0, 2].map((expand) => {
            const start = t.startLine ?? end;
            const lo = Math.min(start, end);
            const hi = Math.max(start, end);
            return searchable.filter((el) => {
              const s = parseInt(el.dataset.lineStart!, 10);
              const e = parseInt(el.dataset.lineEnd!, 10);
              return e >= lo - expand && s <= hi + expand;
            });
          })
        : [searchable];
      for (let wi = 0; wi < windows.length; wi++) {
        const degraded = end ? wi > 0 : false;
        const blocks = windows[wi];
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
          newMatch.set(t.clientKey, degraded ? "recovered" : found.match);
          break;
        }
        const range = document.createRange();
        try {
          range.setStart(found.startNode, found.startOffset);
          range.setEnd(found.endNode, found.endOffset);
          const mark = document.createElement("mark");
          mark.className = `comment-highlight ${t.isResolved ? "resolved" : ""} ${
            found.match === "recovered" ? "recovered" : ""
          }`;
          mark.dataset.threadId = t.clientKey;
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
          newMatch.set(t.clientKey, degraded ? "recovered" : found.match);
          break;
        } catch {
          // skip
        }
      }
      if (!newMatch.has(t.clientKey)) {
        newMatch.set(t.clientKey, "stale");
      }
    }
    setAnchorMatch(newMatch);
  }, [threadAnchors, threadsForFile, fileContent]);

  // Apply active class to currently-highlighted anchor
  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    root.querySelectorAll("mark.comment-highlight").forEach((m) => {
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
    // File-level threads have no line to sit beside. Clear rather than return,
    // or the chip keeps the previous thread's position and points at the
    // wrong paragraph.
    if (!ln) {
      setCollaboratorChipTop(null);
      return;
    }
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
          const m = anchorMatch.get(t.clientKey);
          const hasInlineMark = m === "word" || m === "recovered";
          if (hasInlineMark) continue;
          if (!t.isResolved) unresolvedCount++;
          if (highlightedThread && t.clientKey === highlightedThread) {
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
      const collapsed = window.getSelection()?.isCollapsed;
      const tgt = e.target as HTMLElement | null;
      const markEl = tgt?.closest("mark.comment-highlight") as HTMLElement | null;
      if (!collapsed) {
        return;
      }
      const { threadsByLine: tbl, highlightedThread: ht, flashThread: ft } =
        proseClickStateRef.current;
      // Mark click: trust the mark's threadId. The anchor walker may have
      // placed it in a neighbouring block (it expands by +/-2 lines to
      // recover stale anchors), so the thread won't always be in this
      // block's threadsByLine slice - filtering through that would silently
      // swallow the click when many comments cluster around shifted lines.
      const markThreadId = markEl?.dataset.threadId ?? null;
      let targetId: string | null = markThreadId;
      if (!targetId) {
        const block = tgt?.closest("[data-line-start]") as HTMLElement | null;
        if (!block || !root.contains(block)) {
          return;
        }
        const ln = parseInt(block.dataset.lineStart!, 10);
        const lnEnd = parseInt(block.dataset.lineEnd!, 10);
        const blockThreads: ReviewThread[] = [];
        for (const [k, ts] of tbl) {
          if (k >= ln && k <= lnEnd) blockThreads.push(...ts);
        }
        if (!blockThreads.length) {
          return;
        }
        const unresolved = blockThreads.filter((t) => !t.isResolved);
        const activeThread = ht ? blockThreads.find((t) => t.clientKey === ht) : undefined;
        targetId = unresolved[0]?.clientKey ?? activeThread?.clientKey ?? null;
      }
      if (!targetId) {
        return;
      }
      e.stopPropagation();
      if (ht === targetId) {
        setHighlightedThread(null);
      } else {
        ft(targetId);
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [selectedPR]);

  const retryOp = useCallback(
    (opId: string) => {
      void api.retryOutboxOp(opId).catch((e) => reportError(e, "Retry failed"));
    },
    [reportError],
  );

  const discardOp = useCallback(
    (opId: string) => {
      void api
        .discardOutboxOp(opId)
        .catch((e) => reportError(e, "Couldn't discard"));
    },
    [reportError],
  );

  const prList = (
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
  );

  return (
    <div className="app">
      <Toasts toasts={toasts} onDismiss={dismissToast} />
      {selectedPR && (
        <header className="topbar" data-tauri-drag-region="deep">
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
              <svg
                className="pr-switcher-icon"
                width="15"
                height="15"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  fill="currentColor"
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M7.177 3.073L9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354zM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25zM11 2.5h-1V4h1a1 1 0 0 1 1 1v5.628a2.251 2.251 0 1 0 1.5 0V5A2.5 2.5 0 0 0 11 2.5zm1 10.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM3.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"
                />
              </svg>
              <span className="pr-switcher-label">
                <span className="pr-switcher-num">#{selectedPR.number}</span>
                <span className="pr-switcher-title">{selectedPR.title}</span>
              </span>
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
                {prList}
              </div>
            )}
          </div>
          <button
            className="topbar-icon-btn"
            title={`Open #${selectedPR.number} on GitHub`}
            aria-label="Open this PR on GitHub"
            onClick={() => void openUrl(selectedPR.url)}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path
                fill="currentColor"
                fillRule="evenodd"
                clipRule="evenodd"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
              />
            </svg>
          </button>
          {lastRefreshAt && (
            <span className="last-refresh" title={lastRefreshAt.toLocaleString()}>
              Updated {relativeTime(lastRefreshAt.toISOString())}
            </span>
          )}
          <button
            className={`topbar-icon-btn ${refreshing ? "spinning" : ""}`}
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
          <div className="settings-wrap">
            <button
              className={`topbar-icon-btn ${settingsOpen ? "active" : ""}`}
              title="Settings"
              aria-label="Settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  fill="currentColor"
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M8 0a1 1 0 0 0-1 1v.6a6.4 6.4 0 0 0-1.4.58l-.42-.42a1 1 0 0 0-1.42 0l-.76.76a1 1 0 0 0 0 1.42l.42.42A6.4 6.4 0 0 0 2.6 7H2a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h.6c.13.5.33.96.58 1.4l-.42.42a1 1 0 0 0 0 1.42l.76.76a1 1 0 0 0 1.42 0l.42-.42c.44.25.9.45 1.4.58V15a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-.6a6.4 6.4 0 0 0 1.4-.58l.42.42a1 1 0 0 0 1.42 0l.76-.76a1 1 0 0 0 0-1.42l-.42-.42c.25-.44.45-.9.58-1.4H15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-.6a6.4 6.4 0 0 0-.58-1.4l.42-.42a1 1 0 0 0 0-1.42l-.76-.76a1 1 0 0 0-1.42 0l-.42.42A6.4 6.4 0 0 0 10 1.6V1a1 1 0 0 0-1-1H8zm.5 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"
                />
              </svg>
            </button>
            {settingsOpen && <SettingsMenu settings={appSettings} />}
          </div>
        </header>
      )}
      {selectedPR && searchOpen && (
        <div className="find-bar" role="search">
          <input
            ref={searchInputRef}
            className="find-input"
            type="text"
            placeholder="Find in file"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (searchMatchCount === 0) return;
                setSearchCurrentIndex((i) => {
                  const n = searchMatchCount;
                  if (e.shiftKey) return (i - 1 + n) % n;
                  return (i + 1) % n;
                });
              }
            }}
          />
          <span className="find-count">
            {searchQuery
              ? searchMatchCount === 0
                ? "0/0"
                : `${searchCurrentIndex + 1}/${searchMatchCount}`
              : ""}
          </span>
          <button
            className="find-btn"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            disabled={searchMatchCount === 0}
            onClick={() =>
              setSearchCurrentIndex((i) => {
                const n = searchMatchCount;
                if (n === 0) return -1;
                return (i - 1 + n) % n;
              })
            }
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path fill="currentColor" d="M5 3 1 7h8z" />
            </svg>
          </button>
          <button
            className="find-btn"
            title="Next match (Enter)"
            aria-label="Next match"
            disabled={searchMatchCount === 0}
            onClick={() =>
              setSearchCurrentIndex((i) => {
                const n = searchMatchCount;
                if (n === 0) return -1;
                return (i + 1) % n;
              })
            }
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path fill="currentColor" d="M5 7 1 3h8z" />
            </svg>
          </button>
          <button
            className="find-btn"
            title="Close (Esc)"
            aria-label="Close search"
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery("");
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                fill="currentColor"
                d="M2 1 1 2l3 3-3 3 1 1 3-3 3 3 1-1-3-3 3-3-1-1-3 3z"
              />
            </svg>
          </button>
        </div>
      )}
      {!selectedPR && (
        <div className="pick-pr" data-tauri-drag-region="deep">
          <div className="pick-pr-inner">
            <h1 className="pick-pr-title">Pick a PR to review</h1>
            <p className="pick-pr-sub">
              Choose an open pull request from {repo} to start reading.
            </p>
            <div className="pick-pr-card">
              <input
                className="filter"
                placeholder="Filter PRs"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {prList}
            </div>
            </div>
        </div>
      )}

      {selectedPR && (
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
                      flashThread(collaboratorActivity.thread.clientKey);
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
                {composerCue && selRange && !composerOpen && (
                  <button
                    className="composer-cue"
                    style={{ top: composerCue.top, left: composerCue.left }}
                    // Hold the native selection through the click. Without
                    // preventDefault, mousedown on the button collapses the
                    // window selection before openComposer() can paint the
                    // preview mark from it.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      openComposer();
                    }}
                    title="Comment on selection (c)"
                    aria-label="Comment on selection"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M2.75 2h10.5A1.75 1.75 0 0 1 15 3.75v6.5A1.75 1.75 0 0 1 13.25 12H8.06l-2.97 2.97a.75.75 0 0 1-1.28-.53V12H2.75A1.75 1.75 0 0 1 1 10.25v-6.5A1.75 1.75 0 0 1 2.75 2z"
                      />
                    </svg>
                  </button>
                )}
                {collaboratorChipTop !== null && collaboratorActivity && (
                  <button
                    className={`gutter-chip ${activityFreshness(collaboratorActivity.comment.createdAt)}`}
                    style={{ top: collaboratorChipTop }}
                    onClick={() => {
                      flashThread(collaboratorActivity.thread.clientKey);
                    }}
                    title={`${collaboratorActivity.comment.author.login} · ${relativeTime(collaboratorActivity.comment.createdAt)}`}
                  >
                    <span className="avatar">
                      {collaboratorActivity.comment.author.login[0]?.toUpperCase()}
                    </span>
                  </button>
                )}
                {fileContent ? (
                  <ReactMarkdown
                    key={`${selectedPR?.headRefOid ?? ""}:${activeFile ?? ""}`}
                    remarkPlugins={[remarkGfm]}
                    components={mdComponents as any}
                  >
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
                proseRef={proseRef}
                proseGridRef={proseGridRef}
                registerThreadEl={registerThreadEl}
                fileContent={fileContent}
                onActivate={(t) => {
                  if (highlightedThread === t.clientKey) {
                    setHighlightedThread(null);
                    return;
                  }
                  flashThread(t.clientKey);
                }}
                onResolve={(t) => toggleResolve(t)}
                onReply={(t, body) => replyTo(t, body)}
                onDelete={(commentId) => deleteComment(commentId)}
                onRetryOp={retryOp}
                onDiscardOp={discardOp}
              />
            </div>
          </div>

          {composerOpen && selRange && (
            <div className="composer">
              <div className="composer-header">
                {selAnchor ? (
                  <>
                    Commenting on <span className="anchor-pill">{truncate(selAnchor.exact, 60)}</span>{" "}
                    <span
                      className="composer-line"
                      title={
                        selectionInDiff
                          ? "This passage is in the PR diff, so the comment attaches to the line"
                          : "This passage is outside the PR diff, so the comment attaches to the file and is placed by its anchor text"
                      }
                    >
                      {selectionInDiff ? `L${selRange.end}` : "file"}
                    </span>
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
                  if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
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
                  <kbd className="kbd-inline" aria-label="Enter">⏎</kbd>
                </button>
              </div>
            </div>
          )}
          </main>
        </div>
      )}
    </div>
  );
}

export default App;
