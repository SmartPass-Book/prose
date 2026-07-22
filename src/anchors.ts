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

// clientKey rides inside the marker so the thread's client-side identity
// round-trips through GitHub: replace_threads reads it back on ingestion and
// promotes the optimistic tmp row by exact key match.
export function buildCommentBody(
  userBody: string,
  anchor: Anchor | null,
  clientKey?: string,
): string {
  const payload: Record<string, string> = { ...(anchor ?? {}) };
  if (clientKey) payload.key = clientKey;
  if (Object.keys(payload).length === 0) return userBody;
  const marker = `<!-- nr:v1 ${JSON.stringify(payload)} -->`;
  if (!anchor) return `${userBody.trim()}\n\n${marker}`;
  const exact = anchor.exact.replace(/\s+/g, " ").trim();
  const quote = `> "${exact}"`;
  return `${quote}\n\n${userBody.trim()}\n\n${marker}`;
}

// Capture an anchor from the current DOM Range. Returns null if selection is
// trivial or the range can't be resolved to a single line block.
//
// Invariant we maintain: `prefix + exact + suffix` is a substring of the
// rendered block's text. We trim leading/trailing whitespace off `exact` (so
// the highlighted phrase is tight), but PUSH the trimmed characters into
// prefix/suffix so the composite reconstruction is lossless. Without this,
// a drag that began on a leading space would silently lose that space when
// trimmed, and the matcher would never find a strict (word) match against
// the rendered prose.
export function captureAnchorFromRange(
  range: Range,
  proseRoot: HTMLElement,
  contextLen = 25,
): Anchor | null {
  const raw = range.toString();
  const lead = raw.match(/^\s*/)?.[0] ?? "";
  const tail = raw.match(/\s*$/)?.[0] ?? "";
  // If the entire selection is whitespace, lead+tail covers the whole string
  // and exact ends up empty/negative; bail.
  const exactLen = raw.length - lead.length - tail.length;
  if (exactLen < 2) return null;
  const exact = raw.slice(lead.length, lead.length + exactLen);

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
  const prefix = (preRange.toString() + lead).slice(-contextLen);

  const postRange = document.createRange();
  postRange.selectNodeContents(endBlock);
  postRange.setStart(range.endContainer, range.endOffset);
  const suffix = (tail + postRange.toString()).slice(0, contextLen);

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
      // Composite missed: context drifted. Fall through to bare-exact below
      // and tag it "recovered" so the UI can surface the lost-context state.
      const i2 = haystack.indexOf(anchor.exact);
      if (i2 >= 0) return { idx: i2, match: "recovered" };
      return null;
    }
    // No prefix or suffix was ever captured (selection sat at a block
    // boundary, no surrounding context available). The bare-exact match IS
    // the canonical match here - there's nothing to "recover" because there
    // was no context to drift in the first place.
    const i2 = haystack.indexOf(anchor.exact);
    if (i2 >= 0) return { idx: i2, match: "word" };
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
