/// Finding a spoken sentence back in the rendered DOM.
///
/// `speech.ts` collapses whitespace when it builds an utterance, because that is
/// what gets synthesized. The DOM keeps the source's line breaks, so a sentence
/// that wrapped across two lines in the markdown will not `indexOf` in the
/// rendered text. This matches through a normalized view and maps the hit back
/// to real text-node offsets.

interface Piece {
  node: Text;
  start: number;
  end: number;
}

/// A DOM Range covering `sentence` inside `block`, or null if it isn't there.
///
/// Used to hand the comment composer a selection during playback: it normally
/// anchors to whatever the reader dragged over, and playback has no drag.
export function findSentenceRange(block: HTMLElement, sentence: string): Range | null {
  const target = sentence.replace(/\s+/g, " ").trim();
  if (!target) return null;

  const pieces: Piece[] = [];
  let raw = "";
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    pieces.push({ node: text, start: raw.length, end: raw.length + text.data.length });
    raw += text.data;
  }
  if (raw.length === 0) return null;

  // Normalized text, plus the raw index each normalized character came from.
  let normalized = "";
  const origin: number[] = [];
  let inGap = false;
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) {
      if (!inGap && normalized.length > 0) {
        normalized += " ";
        origin.push(i);
      }
      inGap = true;
      continue;
    }
    inGap = false;
    normalized += raw[i];
    origin.push(i);
  }

  const at = normalized.indexOf(target);
  if (at < 0) return null;
  const rawStart = origin[at];
  // The end is exclusive, so it is one past the last matched character rather
  // than the origin of the character after it - which may be a collapsed run.
  const rawEnd = origin[at + target.length - 1] + 1;

  const startAt = locate(pieces, rawStart);
  const endAt = locate(pieces, rawEnd);
  if (!startAt || !endAt) return null;

  const range = document.createRange();
  range.setStart(startAt.node, startAt.offset);
  range.setEnd(endAt.node, endAt.offset);
  return range;
}

function locate(pieces: Piece[], index: number): { node: Text; offset: number } | null {
  for (const piece of pieces) {
    // `>=` on the end so an index landing exactly at a node's boundary resolves
    // to the end of that node rather than falling off the list.
    if (index >= piece.start && index <= piece.end) {
      return { node: piece.node, offset: index - piece.start };
    }
  }
  return null;
}

/// Put a range on the window selection, replacing whatever was there.
export function selectRange(range: Range): void {
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}
