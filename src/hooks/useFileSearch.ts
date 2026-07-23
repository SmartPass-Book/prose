import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

interface UseFileSearchOptions {
  activeFile: string | null;
  fileContent: string;
  proseRef: RefObject<HTMLDivElement | null>;
}

export function useFileSearch({
  activeFile,
  fileContent,
  proseRef,
}: UseFileSearchOptions) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchCurrentIndex, setSearchCurrentIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchMatchesRef = useRef<HTMLElement[]>([]);

  const unwrapSearchMarks = useCallback(() => {
    const root = proseRef.current;
    if (!root) return;
    const touched = new Set<Node>();
    root.querySelectorAll("mark.search-match").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      touched.add(parent);
    });
    touched.forEach((parent) => (parent as Element).normalize?.());
    searchMatchesRef.current = [];
  }, [proseRef]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "f" && !event.shiftKey) {
        if (!activeFile) return;
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }
      if (key !== "g" || !searchOpen || searchMatchCount === 0) return;
      event.preventDefault();
      setSearchCurrentIndex((index) => {
        if (event.shiftKey) return (index - 1 + searchMatchCount) % searchMatchCount;
        return (index + 1) % searchMatchCount;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeFile, searchOpen, searchMatchCount]);

  useEffect(() => {
    unwrapSearchMarks();
    if (!searchOpen || !searchQuery) {
      setSearchMatchCount(0);
      setSearchCurrentIndex(-1);
      return;
    }
    const root = proseRef.current;
    if (!root) return;
    const query = searchQuery.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest("mark.search-match")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes: Text[] = [];
    let node: Node | null = walker.nextNode();
    while (node) {
      textNodes.push(node as Text);
      node = walker.nextNode();
    }

    const matches: HTMLElement[] = [];
    for (const textNode of textNodes) {
      const value = textNode.nodeValue ?? "";
      if (!value) continue;
      const lower = value.toLowerCase();
      const segments: { start: number; end: number }[] = [];
      let from = 0;
      while (from <= lower.length) {
        const index = lower.indexOf(query, from);
        if (index === -1) break;
        segments.push({ start: index, end: index + query.length });
        from = index + query.length;
      }
      if (!segments.length || !textNode.parentNode) continue;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const segment of segments) {
        if (segment.start > cursor) {
          fragment.appendChild(document.createTextNode(value.slice(cursor, segment.start)));
        }
        const mark = document.createElement("mark");
        mark.className = "search-match";
        mark.appendChild(document.createTextNode(value.slice(segment.start, segment.end)));
        fragment.appendChild(mark);
        matches.push(mark);
        cursor = segment.end;
      }
      if (cursor < value.length) {
        fragment.appendChild(document.createTextNode(value.slice(cursor)));
      }
      textNode.parentNode.replaceChild(fragment, textNode);
    }

    searchMatchesRef.current = matches;
    setSearchMatchCount(matches.length);
    setSearchCurrentIndex(matches.length > 0 ? 0 : -1);
  }, [fileContent, proseRef, searchOpen, searchQuery, unwrapSearchMarks]);

  useEffect(() => {
    const matches = searchMatchesRef.current;
    matches.forEach((match, index) => {
      match.classList.toggle("current", index === searchCurrentIndex);
    });
    if (searchCurrentIndex >= 0 && searchCurrentIndex < matches.length) {
      matches[searchCurrentIndex].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [searchCurrentIndex, searchMatchCount]);

  return {
    state: {
      currentIndex: searchCurrentIndex,
      isOpen: searchOpen,
      matchCount: searchMatchCount,
      query: searchQuery,
    },
    actions: {
      close: closeSearch,
      setCurrentIndex: setSearchCurrentIndex,
      setIsOpen: setSearchOpen,
      setQuery: setSearchQuery,
    },
    refs: { input: searchInputRef },
  };
}
