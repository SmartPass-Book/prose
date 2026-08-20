import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent } from "mdast";

/// Turning a chapter into something a TTS engine can read.
///
/// The parse here is deliberately the *same* one `DocumentPane` renders with
/// (`remark-parse` + `remark-gfm`), because every speakable block has to line up
/// with a rendered block: `useThreadPresentation` stamps `data-line-start` from
/// `node.position.start.line`, and the player finds the block to highlight by
/// that number. Re-deriving positions from a different parser, or scraping the
/// DOM, would let the two drift apart on exactly the constructs where it is
/// hardest to notice.

/// Longest chunk we hand to the synthesizer, in characters of *input text*.
///
/// The real ceiling is Kokoro's 510-token limit, and its tokens are IPA
/// characters, not input characters. Measured (see
/// `the_frontend_chunk_cap_leaves_room_under_the_token_ceiling` in
/// `src-tauri/src/tts/mod.rs`), 349 characters of English phonemizes to 384
/// tokens of ordinary narrative prose and 404 of deliberately
/// short-word-dense prose. So the ratio runs about 1.1 to 1.16 tokens per
/// character, and the hard limit sits somewhere near 440 characters - not far
/// above this cap at all.
///
/// Raising this number therefore needs that test re-run, not arithmetic. 350
/// also keeps the first chunk quick to render, which is what the listener
/// actually feels. `Synthesizer::synth` still returns `ChunkTooLong` rather
/// than trusting any of it.
export const MAX_CHUNK_CHARS = 350;

const PAUSE_SENTENCE_MS = 0;
const PAUSE_PARAGRAPH_MS = 350;
const PAUSE_HEADING_MS = 600;
const PAUSE_SCENE_BREAK_MS = 900;

export type BlockKind = "heading" | "paragraph" | "listItem";

/// One rendered block that has speakable text in it.
export interface SpeakableBlock {
  kind: BlockKind;
  /// Source lines, matching the `data-line-start` / `data-line-end` pair the
  /// renderer puts on the corresponding element.
  lineStart: number;
  lineEnd: number;
  /// The block's full speakable text, whitespace collapsed.
  text: string;
  /// Indices into `SpeakableDoc.utterances`, in order.
  utterances: number[];
}

/// One unit of synthesis, and one unit of highlight. Usually a sentence; a
/// sentence longer than `MAX_CHUNK_CHARS` becomes several.
export interface Utterance {
  index: number;
  /// Index into `SpeakableDoc.blocks`.
  block: number;
  text: string;
  /// Offsets into the owning block's `text`, so the highlighter can find this
  /// sentence inside a block it has already located by line number.
  charStart: number;
  charEnd: number;
  /// Silence to insert after this utterance. Carries paragraph, heading and
  /// scene-break pacing without needing a separate node type in the list.
  pauseAfterMs: number;
}

export interface SpeakableDoc {
  blocks: SpeakableBlock[];
  utterances: Utterance[];
}

/// Where the YAML front matter ends, as a 1-based source line, or 0 if there
/// isn't any.
///
/// We locate it rather than strip it because stripping would shift every line
/// number after it and break the mapping to the rendered blocks. Note that
/// `remark-parse` has no front-matter extension wired up here, so it sees
/// `---` as a thematic break and the fields as an ordinary paragraph - which is
/// how front matter ends up visible in the document, and why it would otherwise
/// be read aloud.
export function frontMatterEndLine(markdown: string): number {
  const lines = markdown.split("\n");
  if (lines[0]?.trimEnd() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line === "---" || line === "...") return i + 1;
  }
  return 0;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/// Flatten a block's inline children into speech.
///
/// This is not `mdast-util-to-string`: that one concatenates image alt text and
/// footnote markers, both of which we are supposed to skip. Emphasis, strong,
/// links and strikethrough contribute their contents; images and footnote
/// references contribute nothing at all.
function inlineText(nodes: PhrasingContent[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;
      case "inlineCode":
        out += node.value;
        break;
      case "emphasis":
      case "strong":
      case "delete":
      case "link":
      case "linkReference":
        out += inlineText(node.children);
        break;
      case "break":
        out += " ";
        break;
      // Images, footnote references and raw inline HTML are silent. The HTML
      // case is what keeps `<!-- nr:v1 {...} -->` anchor markers from being
      // read out as JSON.
      case "image":
      case "imageReference":
      case "footnoteReference":
      case "html":
        break;
      default:
        break;
    }
  }
  return out;
}

interface RawBlock {
  kind: BlockKind;
  lineStart: number;
  lineEnd: number;
  text: string;
  /// Pause owed after this block, before whatever comes next.
  pauseAfterMs: number;
}

/// Walk the tree, emitting one raw block per rendered element that has speech
/// in it.
///
/// Skipped wholesale: code blocks, raw HTML blocks, tables, footnote
/// definitions, and standalone images. A thematic break emits no text but
/// upgrades the pending pause, which is how a scene break becomes silence
/// instead of a spoken word.
function collectBlocks(nodes: RootContent[], out: RawBlock[], skipBefore: number): void {
  for (const node of nodes) {
    const start = node.position?.start.line ?? 0;
    const end = node.position?.end.line ?? start;
    if (start <= skipBefore) continue;

    switch (node.type) {
      case "heading": {
        const text = collapse(inlineText(node.children));
        if (text) {
          out.push({ kind: "heading", lineStart: start, lineEnd: end, text, pauseAfterMs: PAUSE_HEADING_MS });
        }
        break;
      }
      case "paragraph": {
        const text = collapse(inlineText(node.children));
        // A paragraph holding nothing but a figure collapses to "", and drops
        // out here rather than becoming an empty chunk.
        if (text) {
          out.push({ kind: "paragraph", lineStart: start, lineEnd: end, text, pauseAfterMs: PAUSE_PARAGRAPH_MS });
        }
        break;
      }
      case "blockquote":
        // The renderer stamps a line range on both the blockquote and the
        // paragraphs inside it. Descend to the paragraphs: they are the unit
        // of speech, and a single-paragraph quote (the common case) starts on
        // the same line as its blockquote, so the gutter button - which sits on
        // the outer element, per App.css - still resolves here. A quote holding
        // several paragraphs plays from the first, which is what clicking a
        // quote's gutter should do anyway.
        collectBlocks(node.children, out, skipBefore);
        break;
      case "list":
        collectBlocks(node.children, out, skipBefore);
        break;
      case "listItem": {
        // A list item's own line range is what the renderer stamps on the
        // `<li>`, so flatten its paragraphs into one block under that range
        // rather than descending to them.
        const text = collapse(inlineText(listItemInlines(node.children)));
        if (text) {
          out.push({ kind: "listItem", lineStart: start, lineEnd: end, text, pauseAfterMs: PAUSE_PARAGRAPH_MS });
        }
        break;
      }
      case "thematicBreak": {
        // A scene break. Nothing to say; lengthen the silence around it.
        const last = out[out.length - 1];
        if (last) last.pauseAfterMs = Math.max(last.pauseAfterMs, PAUSE_SCENE_BREAK_MS);
        break;
      }
      default:
        // code, html, table, footnoteDefinition, definition, yaml, and
        // anything an extension adds later: silent by default. Reading an
        // unknown construct aloud is a worse failure than skipping it.
        break;
    }
  }
}

function listItemInlines(children: RootContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const child of children) {
    if (child.type === "paragraph") out.push(...child.children);
  }
  return out;
}

/// Words that end in a period without ending a sentence.
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "rev", "hon", "st", "sr", "jr", "vs", "etc",
  "al", "inc", "ltd", "co", "corp", "dept", "est", "fig", "figs", "no", "vol",
  "ch", "chap", "pp", "ed", "eds", "approx", "cf", "ca",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov",
  "dec", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
]);

const TERMINATORS = new Set([".", "!", "?", "…"]);
const CLOSERS = new Set(["\"", "'", "”", "’", ")", "]", "»"]);

/// True if the run of terminators ending at `dotIndex` is an abbreviation's
/// period rather than a full stop.
function isAbbreviation(text: string, dotIndex: number): boolean {
  let i = dotIndex - 1;
  let word = "";
  while (i >= 0 && /[A-Za-z.]/.test(text[i])) {
    word = text[i] + word;
    i--;
  }
  if (!word) return false;
  // "J. R. R. Tolkien" and the trailing letter of "e.g." both reduce to a
  // single letter here, which is the cheapest way to catch initials.
  const bare = word.replace(/\./g, "");
  if (bare.length === 1) return true;
  return ABBREVIATIONS.has(word.toLowerCase().replace(/\.$/, ""));
}

interface Span {
  text: string;
  start: number;
  end: number;
}

/// Split collapsed block text into sentences.
///
/// The bias is deliberate: under-splitting costs latency, because a chunk is
/// not audible until all of it is synthesized, while over-splitting costs a
/// slightly long pause. So an ambiguous boundary splits. The one place that
/// bias is reversed is dialogue - `"Are you sure?" she asked.` must stay whole,
/// which falls out of requiring the next sentence to start with a capital.
export function splitSentences(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  let i = 0;

  while (i < text.length) {
    if (!TERMINATORS.has(text[i])) {
      i++;
      continue;
    }
    const firstTerminator = i;
    while (i < text.length && TERMINATORS.has(text[i])) i++;
    while (i < text.length && CLOSERS.has(text[i])) i++;

    const isSingleDot = text[firstTerminator] === "." && i === firstTerminator + 1;
    if (isSingleDot && isAbbreviation(text, firstTerminator)) continue;

    // A boundary needs whitespace after it. Without this, "3.5" and "example.com"
    // would split.
    let j = i;
    if (j < text.length && !/\s/.test(text[j])) continue;
    while (j < text.length && /\s/.test(text[j])) j++;

    if (j < text.length) {
      const next = text[j];
      // Lowercase after a terminator means the sentence carried on:
      // an abbreviation we did not list, or a dialogue tag.
      const opensSentence = /[A-Z0-9‘“"'(\[—]/.test(next);
      if (!opensSentence) continue;
    }

    const chunk = text.slice(start, i).trim();
    if (chunk) spans.push({ text: chunk, start, end: i });
    start = j;
    i = j;
  }

  const tail = text.slice(start).trim();
  if (tail) spans.push({ text: tail, start, end: text.length });
  return spans;
}

/// Break a span that exceeds `MAX_CHUNK_CHARS` at the best clause boundary
/// available, falling back to a word boundary.
function splitLong(span: Span, text: string, cap: number): Span[] {
  if (span.text.length <= cap) return [span];

  const slice = text.slice(span.start, span.end);
  const window = slice.slice(0, cap);
  // Prefer a clause break in the back half of the window: splitting at the very
  // first comma would produce a stub.
  let cut = -1;
  for (const punct of [";", ":", "—", ","]) {
    const at = window.lastIndexOf(punct);
    if (at > cap / 2 && at > cut) cut = at + 1;
  }
  if (cut < 0) cut = window.lastIndexOf(" ");
  if (cut <= 0) cut = cap;

  const head: Span = {
    text: slice.slice(0, cut).trim(),
    start: span.start,
    end: span.start + cut,
  };
  const rest: Span = {
    text: slice.slice(cut).trim(),
    start: span.start + cut,
    end: span.end,
  };
  if (!head.text) return [span];
  return [head, ...splitLong(rest, text, cap)];
}

/// Parse a chapter into the ordered speech the player reads.
export function extractSpeakable(markdown: string, cap = MAX_CHUNK_CHARS): SpeakableDoc {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const raw: RawBlock[] = [];
  collectBlocks(tree.children, raw, frontMatterEndLine(markdown));

  const blocks: SpeakableBlock[] = [];
  const utterances: Utterance[] = [];

  for (const block of raw) {
    const spans = splitSentences(block.text).flatMap((s) => splitLong(s, block.text, cap));
    if (spans.length === 0) continue;

    const blockIndex = blocks.length;
    const indices: number[] = [];
    for (let k = 0; k < spans.length; k++) {
      const span = spans[k];
      const last = k === spans.length - 1;
      indices.push(utterances.length);
      utterances.push({
        index: utterances.length,
        block: blockIndex,
        text: span.text,
        charStart: span.start,
        charEnd: span.end,
        pauseAfterMs: last ? block.pauseAfterMs : PAUSE_SENTENCE_MS,
      });
    }
    blocks.push({
      kind: block.kind,
      lineStart: block.lineStart,
      lineEnd: block.lineEnd,
      text: block.text,
      utterances: indices,
    });
  }

  return { blocks, utterances };
}

/// The utterance to start at when the reader clicks a block's gutter play
/// button, given that block's `data-line-start`.
///
/// Falls forward to the next speakable block rather than failing, so clicking
/// the gutter next to a figure or a code block starts at the prose after it
/// instead of doing nothing.
export function utteranceForLine(doc: SpeakableDoc, line: number): number | null {
  for (const block of doc.blocks) {
    if (block.lineEnd < line) continue;
    return block.utterances[0] ?? null;
  }
  return null;
}
