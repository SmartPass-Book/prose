import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Components } from "react-markdown";
import { findAnchorRange, parseAnchor, type Anchor, type AnchorMatch } from "../lib/anchors";
import { RepoImage } from "../components/RepoImage";
import type { PR, ReviewComment, ReviewThread } from "../types";

interface UseThreadPresentationOptions {
  activeFile: string | null;
  currentUser: string | null;
  fileContent: string;
  proseRef: RefObject<HTMLDivElement | null>;
  /** Needed to fetch figures, which are private-repo assets. */
  repo: string;
  selectedPR: PR | null;
  showResolved: boolean;
  threads: ReviewThread[];
}

export function useThreadPresentation({
  activeFile,
  currentUser,
  fileContent,
  proseRef,
  repo,
  selectedPR,
  showResolved,
  threads,
}: UseThreadPresentationOptions) {
  const [anchorMatch, setAnchorMatch] = useState<Map<string, AnchorMatch>>(new Map());
  const [highlightedThread, setHighlightedThread] = useState<string | null>(null);
  const [collaboratorChipTop, setCollaboratorChipTop] = useState<number | null>(null);
  const proseGridRef = useRef<HTMLDivElement>(null);
  const threadRefs = useRef<Map<string, HTMLElement>>(new Map());

  const registerThreadEl = useCallback((id: string, element: HTMLElement | null) => {
    if (element) threadRefs.current.set(id, element);
    else threadRefs.current.delete(id);
  }, []);

  const flashThread = useCallback((id: string) => {
    setHighlightedThread(id);
    threadRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const threadsForFile = useMemo(
    () =>
      threads.filter(
        (thread) => thread.path === activeFile && (showResolved || !thread.isResolved),
      ),
    [activeFile, showResolved, threads],
  );

  const resolvedCount = useMemo(
    () => threads.filter((thread) => thread.path === activeFile && thread.isResolved).length,
    [activeFile, threads],
  );

  const filesSorted = useMemo(() => {
    if (!selectedPR) return [];
    const counts = new Map<string, number>();
    for (const thread of threads) {
      if (!thread.isResolved) {
        counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
      }
    }
    return [...selectedPR.files]
      .map((file) => ({ ...file, unresolved: counts.get(file.path) ?? 0 }))
      .sort(
        (left, right) =>
          right.unresolved - left.unresolved || left.path.localeCompare(right.path),
      );
  }, [selectedPR, threads]);

  const threadAnchors = useMemo(() => {
    const anchors = new Map<string, Anchor>();
    for (const thread of threadsForFile) {
      const first = thread.comments.nodes[0];
      if (!first) continue;
      const anchor = parseAnchor(first.body);
      if (anchor) anchors.set(thread.clientKey, anchor);
    }
    return anchors;
  }, [threadsForFile]);

  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    const selection = window.getSelection();
    const skippedBlocks = new Set<HTMLElement>();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const findBlock = (node: Node | null): HTMLElement | null => {
        let current = node;
        while (current && current !== root) {
          if (current instanceof HTMLElement && current.dataset.lineStart) return current;
          current = current.parentNode;
        }
        return null;
      };
      const start = findBlock(range.startContainer);
      const end = findBlock(range.endContainer);
      if (start) skippedBlocks.add(start);
      if (end) skippedBlocks.add(end);
    }

    const touched = new Set<HTMLElement>();
    root
      .querySelectorAll("mark.comment-highlight:not(.preview-anchor)")
      .forEach((mark) => {
        const block = (mark as HTMLElement).closest(
          "[data-line-start]",
        ) as HTMLElement | null;
        if (block && skippedBlocks.has(block)) return;
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        if (block) touched.add(block);
      });
    touched.forEach((block) => block.normalize());

    const nextMatches = new Map<string, AnchorMatch>();
    if (threadAnchors.size === 0) {
      setAnchorMatch((current) => (current.size === 0 ? current : nextMatches));
      return;
    }
    const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-line-start]"));
    const searchable = blocks.filter((block) => !skippedBlocks.has(block));

    for (const thread of threadsForFile) {
      const anchor = threadAnchors.get(thread.clientKey);
      if (!anchor) continue;
      const end = thread.line ?? thread.originalLine ?? 0;
      const windows: HTMLElement[][] = end
        ? [0, 2].map((expansion) => {
            const start = thread.startLine ?? end;
            const low = Math.min(start, end);
            const high = Math.max(start, end);
            return searchable.filter((element) => {
              const elementStart = parseInt(element.dataset.lineStart!, 10);
              const elementEnd = parseInt(element.dataset.lineEnd!, 10);
              return elementEnd >= low - expansion && elementStart <= high + expansion;
            });
          })
        : [searchable];
      for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
        const degraded = end ? windowIndex > 0 : false;
        const found = findAnchorRange(windows[windowIndex], anchor);
        if (!found) continue;
        const startBlock = found.startNode.parentElement?.closest("[data-line-start]");
        const endBlock = found.endNode.parentElement?.closest("[data-line-start]");
        if (startBlock !== endBlock) {
          nextMatches.set(thread.clientKey, degraded ? "recovered" : found.match);
          break;
        }
        const range = document.createRange();
        try {
          range.setStart(found.startNode, found.startOffset);
          range.setEnd(found.endNode, found.endOffset);
          const mark = document.createElement("mark");
          mark.className = `comment-highlight ${thread.isResolved ? "resolved" : ""} ${
            found.match === "recovered" ? "recovered" : ""
          }`;
          mark.dataset.threadId = thread.clientKey;
          try {
            range.surroundContents(mark);
          } catch {
            mark.appendChild(range.extractContents());
            range.insertNode(mark);
          }
          nextMatches.set(thread.clientKey, degraded ? "recovered" : found.match);
          break;
        } catch {
          // Invalid ranges are shown as stale thread cards without an inline mark.
        }
      }
      if (!nextMatches.has(thread.clientKey)) {
        nextMatches.set(thread.clientKey, "stale");
      }
    }
    setAnchorMatch(nextMatches);
  }, [fileContent, proseRef, threadAnchors, threadsForFile]);

  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    root.querySelectorAll("mark.comment-highlight").forEach((mark) => {
      mark.classList.toggle(
        "active",
        (mark as HTMLElement).dataset.threadId === highlightedThread,
      );
    });
  }, [anchorMatch, highlightedThread, proseRef]);

  const threadsByLine = useMemo(() => {
    const grouped = new Map<number, ReviewThread[]>();
    for (const thread of threadsForFile) {
      const end = thread.line ?? thread.originalLine ?? 0;
      if (!end) continue;
      const start = thread.startLine ?? end;
      for (let line = Math.min(start, end); line <= Math.max(start, end); line++) {
        if (!grouped.has(line)) grouped.set(line, []);
        grouped.get(line)!.push(thread);
      }
    }
    return grouped;
  }, [threadsForFile]);

  const collaboratorActivity = useMemo(() => {
    let latest: { thread: ReviewThread; comment: ReviewComment } | null = null;
    for (const thread of threads) {
      if (thread.path !== activeFile) continue;
      for (const comment of thread.comments.nodes) {
        if (currentUser && comment.author?.login === currentUser) continue;
        if (!latest || comment.createdAt > latest.comment.createdAt) {
          latest = { thread, comment };
        }
      }
    }
    return latest;
  }, [activeFile, currentUser, threads]);

  useEffect(() => {
    if (!collaboratorActivity || !proseRef.current) {
      setCollaboratorChipTop(null);
      return;
    }
    const line =
      collaboratorActivity.thread.line ?? collaboratorActivity.thread.originalLine;
    if (!line) {
      setCollaboratorChipTop(null);
      return;
    }
    const elements = proseRef.current.querySelectorAll<HTMLElement>("[data-line-start]");
    for (const element of elements) {
      const start = parseInt(element.dataset.lineStart!, 10);
      const end = parseInt(element.dataset.lineEnd!, 10);
      if (start <= line && end >= line) {
        const proseRect = proseRef.current.getBoundingClientRect();
        setCollaboratorChipTop(element.getBoundingClientRect().top - proseRect.top);
        return;
      }
    }
    setCollaboratorChipTop(null);
  }, [collaboratorActivity, fileContent, proseRef, threads]);

  const scrollToLine = useCallback(
    (line: number) => {
      const elements = proseRef.current?.querySelectorAll<HTMLElement>("[data-line-start]");
      if (!elements) return;
      for (const element of elements) {
        const start = parseInt(element.dataset.lineStart!, 10);
        const end = parseInt(element.dataset.lineEnd!, 10);
        if (start > line || end < line) continue;
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.classList.add("flash");
        setTimeout(() => element.classList.remove("flash"), 1200);
        return;
      }
    },
    [proseRef],
  );

  const markdownComponents = useMemo<Components>(() => {
    const lineProps = (node: any): Record<string, any> => {
      const start = node?.position?.start?.line;
      const end = node?.position?.end?.line;
      return start ? { "data-line-start": start, "data-line-end": end ?? start } : {};
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
      // Figures are repo-relative paths in a private repo, so the webview
      // can't load them from the markup alone; RepoImage fetches the bytes
      // through the backend. Keyed on the head commit so a cached figure is
      // never stale, and on the referencing file so relative paths resolve.
      img: ({ node: _node, src, alt, title }: any) => (
        <RepoImage
          repo={repo}
          gitRef={selectedPR?.headRefOid ?? ""}
          fromFile={activeFile ?? ""}
          src={typeof src === "string" ? src : undefined}
          alt={typeof alt === "string" ? alt : undefined}
          title={typeof title === "string" ? title : undefined}
        />
      ),
    };
  }, [activeFile, repo, selectedPR?.headRefOid]);

  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    const blocks = root.querySelectorAll<HTMLElement>("[data-line-start]");
    for (const block of blocks) {
      const start = parseInt(block.dataset.lineStart!, 10);
      const end = parseInt(block.dataset.lineEnd!, 10);
      let unresolvedCount = 0;
      let activeIsResolved: boolean | null = null;
      let activePresent = false;
      for (const [line, lineThreads] of threadsByLine) {
        if (line < start || line > end) continue;
        for (const thread of lineThreads) {
          const match = anchorMatch.get(thread.clientKey);
          if (match === "word" || match === "recovered") continue;
          if (!thread.isResolved) unresolvedCount++;
          if (highlightedThread === thread.clientKey) {
            activePresent = true;
            activeIsResolved = thread.isResolved;
          }
        }
      }
      block.classList.toggle("has-thread", unresolvedCount > 0 || activePresent);
      block.classList.toggle("thread-active", activePresent);
      block.classList.toggle("thread-resolved", activeIsResolved === true);
    }
  }, [anchorMatch, fileContent, highlightedThread, proseRef, threadsByLine]);

  const clickState = useRef({ threadsByLine, highlightedThread, flashThread });
  useEffect(() => {
    clickState.current = { threadsByLine, highlightedThread, flashThread };
  }, [flashThread, highlightedThread, threadsByLine]);

  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      const target = event.target as HTMLElement | null;
      const markedThread = (
        target?.closest("mark.comment-highlight") as HTMLElement | null
      )?.dataset.threadId;
      const current = clickState.current;
      let targetId = markedThread ?? null;
      if (!targetId) {
        const block = target?.closest("[data-line-start]") as HTMLElement | null;
        if (!block || !root.contains(block)) return;
        const start = parseInt(block.dataset.lineStart!, 10);
        const end = parseInt(block.dataset.lineEnd!, 10);
        const blockThreads: ReviewThread[] = [];
        for (const [line, lineThreads] of current.threadsByLine) {
          if (line >= start && line <= end) blockThreads.push(...lineThreads);
        }
        if (!blockThreads.length) return;
        const unresolved = blockThreads.filter((thread) => !thread.isResolved);
        const active = current.highlightedThread
          ? blockThreads.find(
              (thread) => thread.clientKey === current.highlightedThread,
            )
          : undefined;
        targetId = unresolved[0]?.clientKey ?? active?.clientKey ?? null;
      }
      if (!targetId) return;
      event.stopPropagation();
      if (current.highlightedThread === targetId) setHighlightedThread(null);
      else current.flashThread(targetId);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [proseRef, selectedPR]);

  return {
    state: {
      anchorMatch,
      collaboratorActivity,
      collaboratorChipTop,
      filesSorted,
      highlightedThread,
      markdownComponents,
      resolvedCount,
      threadAnchors,
      threadsForFile,
    },
    actions: {
      flashThread,
      scrollToLine,
      setHighlightedThread,
    },
    refs: {
      proseGrid: proseGridRef,
      registerThreadEl,
    },
  };
}
