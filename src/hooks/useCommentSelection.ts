import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { LineRange } from "../components";
import { captureAnchorFromRange, type Anchor } from "../lib/anchors";
import type { PR } from "../types";

interface UseCommentSelectionOptions {
  activeFile: string | null;
  autoComposer: boolean;
  postComment: (range: LineRange, anchor: Anchor | null, body: string) => Promise<void>;
  proseRef: RefObject<HTMLDivElement | null>;
  reportError: (error: unknown, title?: string) => void;
  selectedPR: PR | null;
}

export function useCommentSelection({
  activeFile,
  autoComposer,
  postComment,
  proseRef,
  reportError,
  selectedPR,
}: UseCommentSelectionOptions) {
  const [selectionRange, setSelectionRange] = useState<LineRange | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<Anchor | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerBody, setComposerBody] = useState("");
  const [composerCue, setComposerCue] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const previewMarksRef = useRef<HTMLElement[]>([]);

  const paintPreviewMark = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const textNodes: Text[] = [];
    if (ancestor.nodeType === Node.TEXT_NODE) {
      textNodes.push(ancestor as Text);
    } else {
      const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          range.intersectsNode(node)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      });
      let node: Node | null;
      while ((node = walker.nextNode())) textNodes.push(node as Text);
    }

    const marks: HTMLElement[] = [];
    for (const textNode of textNodes) {
      const start = textNode === range.startContainer ? range.startOffset : 0;
      const end =
        textNode === range.endContainer ? range.endOffset : textNode.data.length;
      if (start >= end || !textNode.data.slice(start, end).trim()) continue;
      const segment = document.createRange();
      segment.setStart(textNode, start);
      segment.setEnd(textNode, end);
      const mark = document.createElement("mark");
      mark.className = "comment-highlight preview-anchor";
      try {
        segment.surroundContents(mark);
        marks.push(mark);
      } catch {
        // A segment that cannot be wrapped is left to the native selection.
      }
    }
    if (!marks.length) return;
    previewMarksRef.current = marks;
    selection.removeAllRanges();
  }, []);

  const clearPreviewMark = useCallback(() => {
    if (!previewMarksRef.current.length) return;
    const touched = new Set<Node>();
    for (const mark of previewMarksRef.current) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      touched.add(parent);
    }
    touched.forEach((parent) => (parent as Element).normalize?.());
    previewMarksRef.current = [];
  }, []);

  const captureSelection = useCallback((): {
    range: LineRange;
    anchor: Anchor | null;
  } | null => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!proseRef.current?.contains(range.commonAncestorContainer)) return null;
    const findLineElement = (node: Node | null): HTMLElement | null => {
      let current = node;
      while (current && current !== proseRef.current) {
        if (current instanceof HTMLElement && current.dataset.lineStart) return current;
        current = current.parentNode;
      }
      return null;
    };
    const startElement = findLineElement(range.startContainer);
    const endElement = findLineElement(range.endContainer);
    if (!startElement || !endElement) return null;
    const start = Math.min(
      parseInt(startElement.dataset.lineStart!, 10),
      parseInt(endElement.dataset.lineStart!, 10),
    );
    const end = Math.max(
      parseInt(startElement.dataset.lineEnd!, 10),
      parseInt(endElement.dataset.lineEnd!, 10),
    );
    return {
      range: { start, end },
      anchor: captureAnchorFromRange(range, proseRef.current),
    };
  }, [proseRef]);

  const computeCuePosition = useCallback(() => {
    const prose = proseRef.current;
    const selection = window.getSelection();
    if (!prose || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!prose.contains(range.commonAncestorContainer)) return null;
    const rects = range.getClientRects();
    const last = rects.length
      ? rects[rects.length - 1]
      : range.getBoundingClientRect();
    const proseRect = prose.getBoundingClientRect();
    return {
      top: last.top - proseRect.top + last.height / 2,
      left: last.right - proseRect.left + 6,
    };
  }, [proseRef]);

  const openComposer = useCallback(() => {
    paintPreviewMark();
    setComposerOpen(true);
    setComposerCue(null);
  }, [paintPreviewMark]);

  const closeComposer = useCallback(() => setComposerOpen(false), []);

  const resolveSelection = useCallback(() => {
    const captured = captureSelection();
    if (captured) {
      setSelectionRange(captured.range);
      setSelectionAnchor(captured.anchor);
      return captured;
    }
    if (selectionRange) {
      return { range: selectionRange, anchor: selectionAnchor };
    }
    return null;
  }, [captureSelection, selectionAnchor, selectionRange]);

  const clearSelection = useCallback(() => {
    setSelectionRange(null);
    setSelectionAnchor(null);
    setComposerCue(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    if (!composerOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && !target.closest(".composer")) setComposerOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [composerOpen]);

  useEffect(() => {
    if (!composerOpen) clearPreviewMark();
  }, [clearPreviewMark, composerOpen]);

  useEffect(() => {
    setComposerCue(null);
  }, [activeFile, selectedPR?.headRefOid, composerOpen]);

  const onMouseUp = useCallback(() => {
    if (composerOpen) return;
    const captured = captureSelection();
    if (!captured) {
      setSelectionRange(null);
      setSelectionAnchor(null);
      setComposerCue(null);
      return;
    }
    setSelectionRange(captured.range);
    setSelectionAnchor(captured.anchor);
    if (autoComposer) {
      openComposer();
      return;
    }
    setComposerCue(computeCuePosition());
  }, [autoComposer, captureSelection, composerOpen, computeCuePosition, openComposer]);

  const submitComment = useCallback(async () => {
    if (!selectionRange || !composerBody.trim()) return;
    try {
      await postComment(selectionRange, selectionAnchor, composerBody);
      setComposerBody("");
      setComposerOpen(false);
      setSelectionRange(null);
      setSelectionAnchor(null);
      clearPreviewMark();
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      reportError(error, "Couldn't post comment");
    }
  }, [
    clearPreviewMark,
    composerBody,
    postComment,
    reportError,
    selectionAnchor,
    selectionRange,
  ]);

  const selectionInDiff = (() => {
    if (!selectionRange || !activeFile || !selectedPR) return false;
    const ranges = selectedPR.files.find((file) => file.path === activeFile)?.commentable;
    if (!ranges) return false;
    const low = Math.min(selectionRange.start, selectionRange.end);
    const high = Math.max(selectionRange.start, selectionRange.end);
    return ranges.some(([start, end]) => low >= start && high <= end);
  })();

  return {
    state: {
      anchor: selectionAnchor,
      body: composerBody,
      cue: composerCue,
      inDiff: selectionInDiff,
      isOpen: composerOpen,
      range: selectionRange,
    },
    actions: {
      clear: clearSelection,
      close: closeComposer,
      handleMouseUp: onMouseUp,
      open: openComposer,
      resolve: resolveSelection,
      setBody: setComposerBody,
      submit: submitComment,
    },
  };
}
