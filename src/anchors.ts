export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
}

const MARKER_RE = /<!--\s*nr:v1\s+(\{[\s\S]*?\})\s*-->/;

export function parseAnchor(body: string): Anchor | null {
  const m = body.match(MARKER_RE);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (
      typeof obj.exact === "string" &&
      typeof obj.prefix === "string" &&
      typeof obj.suffix === "string"
    ) {
      return obj as Anchor;
    }
  } catch {
    // ignore
  }
  return null;
}

// Returns the body with the marker (and the leading blockquote we injected) stripped,
// so we can show a clean comment in the sidebar.
export function stripAnchorFromBody(body: string): string {
  let s = body.replace(MARKER_RE, "").trim();
  // Strip a leading single-line blockquote like:  > "exact phrase"
  s = s.replace(/^>\s*"[^\n]*"\s*\n+/, "");
  return s.trim();
}

export function buildCommentBody(userBody: string, anchor: Anchor | null): string {
  if (!anchor) return userBody;
  const exact = anchor.exact.replace(/\s+/g, " ").trim();
  const quote = `> "${exact}"`;
  const marker = `<!-- nr:v1 ${JSON.stringify(anchor)} -->`;
  return `${quote}\n\n${userBody.trim()}\n\n${marker}`;
}

// Capture an anchor from the current DOM Range. Returns null if selection is
// trivial or the range can't be resolved to a single line block.
export function captureAnchorFromRange(
  range: Range,
  proseRoot: HTMLElement,
  contextLen = 25,
): Anchor | null {
  const exact = range.toString().trim();
  if (exact.length < 2) return null;

  function blockOf(node: Node | null): HTMLElement | null {
    let n: Node | null = node;
    while (n && n !== proseRoot) {
      if (n instanceof HTMLElement && n.dataset.lineStart) return n;
      n = n.parentNode;
    }
    return null;
  }

  const startBlock = blockOf(range.startContainer);
  const endBlock = blockOf(range.endContainer);
  if (!startBlock || !endBlock) return null;

  const preRange = document.createRange();
  preRange.selectNodeContents(startBlock);
  preRange.setEnd(range.startContainer, range.startOffset);
  const prefix = preRange.toString().slice(-contextLen);

  const postRange = document.createRange();
  postRange.selectNodeContents(endBlock);
  postRange.setStart(range.endContainer, range.endOffset);
  const suffix = postRange.toString().slice(0, contextLen);

  return { exact, prefix, suffix };
}

export type AnchorMatch = "word" | "recovered" | "stale";

interface FindResult {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
  match: AnchorMatch;
}

// Walk text nodes in a set of blocks to locate the anchor's exact text using
// prefix+exact+suffix matching. Falls back to plain exact match if the
// surrounding context has drifted.
export function findAnchorRange(
  blocks: HTMLElement[],
  anchor: Anchor,
): FindResult | null {
  if (blocks.length === 0) return null;

  // Collect text nodes and a flat string with index mapping
  const textNodes: Text[] = [];
  let flat = "";
  const ranges: { node: Text; start: number; end: number }[] = [];
  for (const block of blocks) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const tn = n as Text;
      const len = tn.data.length;
      ranges.push({ node: tn, start: flat.length, end: flat.length + len });
      flat += tn.data;
      textNodes.push(tn);
    }
    // Block boundary: pad with newline so prefix/suffix don't bleed across blocks
    const pad = "\n";
    ranges.push({ node: textNodes[textNodes.length - 1], start: flat.length, end: flat.length + pad.length });
    flat += pad;
  }

  const findFlat = (haystack: string): { idx: number; match: AnchorMatch } | null => {
    if (anchor.prefix || anchor.suffix) {
      const composite = anchor.prefix + anchor.exact + anchor.suffix;
      const i = haystack.indexOf(composite);
      if (i >= 0) return { idx: i + anchor.prefix.length, match: "word" };
    }
    const i2 = haystack.indexOf(anchor.exact);
    if (i2 >= 0) return { idx: i2, match: "recovered" };
    return null;
  };

  const found = findFlat(flat);
  if (!found) return null;

  const targetStart = found.idx;
  const targetEnd = found.idx + anchor.exact.length;

  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  for (const r of ranges) {
    if (!startNode && r.end > targetStart) {
      startNode = r.node;
      startOffset = targetStart - r.start;
    }
    if (startNode && r.end >= targetEnd) {
      endNode = r.node;
      endOffset = targetEnd - r.start;
      break;
    }
  }
  if (!startNode || !endNode) return null;
  return { startNode, startOffset, endNode, endOffset, match: found.match };
}
