import { useEffect, useMemo, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api";
import type { PR, PRSummary, ReviewComment, ReviewThread } from "./types";
import "./App.css";

const REPO_KEY = "nr.repo";
const DEFAULT_REPO = "SmartPass-Book/book";

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
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerBody, setComposerBody] = useState("");
  const [highlightedThread, setHighlightedThread] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [newThreadIds, setNewThreadIds] = useState<Set<string>>(new Set());
  const [peterChipTop, setPeterChipTop] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
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

  const loadPRs = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await api.listPRs(repo);
      setPRs(list);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    loadPRs();
    api.getCurrentUser().then(setCurrentUser).catch(() => {});
  }, [loadPRs]);

  // Tick every 30s so relative timestamps re-render
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Live polling for thread updates
  useEffect(() => {
    if (!selectedPR) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const fetched = await api.getThreads(repo, selectedPR.number);
        if (cancelled) return;
        setThreads((prev) => {
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
        // ignore transient errors
      }
      if (!cancelled) {
        const delay = document.visibilityState === "visible" ? 8000 : 60000;
        timer = setTimeout(tick, delay);
      }
    };
    timer = setTimeout(tick, 8000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
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
      setLoading(true);
      setErr(null);
      setSelectedPR(null);
      setThreads([]);
      setActiveFile(null);
      setFileContent("");
      try {
        const pr = await api.getPR(repo, number);
        setSelectedPR(pr);
        const mdFile =
          pr.files.find((f) => f.path.endsWith(".md")) || pr.files[0];
        if (mdFile) {
          setActiveFile(mdFile.path);
          const content = await api.getFile(repo, pr.headRefOid, mdFile.path);
          setFileContent(content);
        }
        const t = await api.getThreads(repo, number);
        setThreads(t);
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
      return;
    }
    const range = sel.getRangeAt(0);
    if (!proseRef.current?.contains(range.commonAncestorContainer)) {
      setSelRange(null);
      return;
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
      setSelRange(null);
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
    setLoading(true);
    setErr(null);
    try {
      await api.postComment({
        repo,
        number: selectedPR.number,
        commitId: selectedPR.headRefOid,
        path: activeFile,
        line: selRange.end,
        startLine: selRange.start === selRange.end ? undefined : selRange.start,
        body: composerBody,
      });
      setComposerBody("");
      setComposerOpen(false);
      setSelRange(null);
      window.getSelection()?.removeAllRanges();
      const t = await api.getThreads(repo, selectedPR.number);
      setThreads(t);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [activeFile, composerBody, repo, selRange, selectedPR]);

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
        await api.resolveThread(thread.id, !thread.isResolved);
        await refreshThreads();
      } catch (e: any) {
        setErr(String(e));
      }
    },
    [refreshThreads],
  );

  const replyTo = useCallback(
    async (thread: ReviewThread, body: string) => {
      if (!selectedPR) return;
      const first = thread.comments.nodes[0];
      if (!first) return;
      try {
        await api.replyToComment(repo, selectedPR.number, first.databaseId, body);
        await refreshThreads();
      } catch (e: any) {
        setErr(String(e));
      }
    },
    [refreshThreads, repo, selectedPR],
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

  const mdComponents = useMemo(() => {
    const lineProps = (node: any): Record<string, any> => {
      const start = node?.position?.start?.line;
      const end = node?.position?.end?.line;
      if (!start) return {};
      return { "data-line-start": start, "data-line-end": end ?? start };
    };
    const wrap = (Tag: any) => (props: any) => {
      const { node, children, className, ...rest } = props;
      const lp = lineProps(node);
      const ln = lp["data-line-start"] as number | undefined;
      const lnEnd = lp["data-line-end"] as number | undefined;
      const blockThreads: ReviewThread[] = [];
      if (ln !== undefined) {
        for (const [k, ts] of threadsByLine) {
          if (k >= ln && k <= (lnEnd ?? ln)) blockThreads.push(...ts);
        }
      }
      const unresolved = blockThreads.filter((t) => !t.isResolved);
      const activeThread =
        highlightedThread !== null
          ? blockThreads.find((t) => t.id === highlightedThread)
          : undefined;
      const showHighlight = unresolved.length > 0 || !!activeThread;
      const cls = [
        className,
        showHighlight ? "has-thread" : "",
        activeThread ? "thread-active" : "",
        activeThread?.isResolved ? "thread-resolved" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const clickTarget = unresolved[0] ?? activeThread;
      const onClick = clickTarget
        ? (e: ReactMouseEvent) => {
            if (!window.getSelection()?.isCollapsed) return;
            e.stopPropagation();
            if (activeThread && activeThread.id === clickTarget.id) {
              setHighlightedThread(null);
            } else {
              flashThread(clickTarget.id);
            }
          }
        : undefined;
      return (
        <Tag {...rest} {...lp} className={cls || undefined} onClick={onClick}>
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
  }, [threadsByLine, highlightedThread, flashThread]);

  return (
    <div className="app">
      <header className="topbar">
        <input
          className="repo-input"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onBlur={loadPRs}
          spellCheck={false}
        />
        <button onClick={loadPRs} disabled={loading}>
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

      <div className="layout">
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

        <main className="main">
          {selectedPR && (
            <div className="file-tabs">
              {selectedPR.files.map((f) => (
                <button
                  key={f.path}
                  className={f.path === activeFile ? "active" : ""}
                  onClick={() => switchFile(f.path)}
                  title={f.path}
                >
                  {f.path.split("/").pop()}
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
              <span>
                Lines {selRange.start}
                {selRange.end !== selRange.start ? `–${selRange.end}` : ""}
              </span>
              <button className="primary" onClick={() => setComposerOpen(true)}>
                + Comment <kbd>c</kbd>
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
                Comment on lines {selRange.start}
                {selRange.end !== selRange.start ? `–${selRange.end}` : ""}
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
                  highlighted={highlightedThread === t.id}
                  isNew={newThreadIds.has(t.id)}
                  registerEl={(el) => registerThreadEl(t.id, el)}
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
  highlighted,
  isNew,
  registerEl,
  onActivate,
  onResolve,
  onReply,
}: {
  thread: ReviewThread;
  highlighted: boolean;
  isNew: boolean;
  registerEl: (el: HTMLElement | null) => void;
  onActivate: () => void;
  onResolve: () => void;
  onReply: (body: string) => void;
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
      <ul className="comments">
        {thread.comments.nodes.map((c) => (
          <li key={c.id}>
            <div className="comment-author">
              {c.author?.login} · {new Date(c.createdAt).toLocaleString()}
            </div>
            <div className="comment-body">{c.body}</div>
          </li>
        ))}
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

export default App;
