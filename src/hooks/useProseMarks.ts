import { useCallback, type RefObject } from "react";

export function useProseMarks(proseRef: RefObject<HTMLDivElement | null>) {
  const unwrapMarks = useCallback(() => {
    const root = proseRef.current;
    if (!root) return;
    const touched = new Set<Node>();
    root
      .querySelectorAll("mark.comment-highlight, mark.search-match")
      .forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        touched.add(parent);
      });
    touched.forEach((parent) => (parent as Element).normalize?.());
  }, [proseRef]);

  return { unwrapMarks };
}
