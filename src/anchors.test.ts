import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { describe, test, expect, beforeEach } from "bun:test";
import {
  parseAnchor,
  stripAnchorFromBody,
  buildCommentBody,
  captureAnchorFromRange,
  findAnchorRange,
  type Anchor,
} from "./anchors";

// ---- Pure-function suites ----------------------------------------------------

describe("parseAnchor", () => {
  test("extracts a valid v1 marker", () => {
    const body = `> "foo"\n\nThe comment\n\n<!-- nr:v1 {"exact":"foo","prefix":"a ","suffix":" b"} -->`;
    expect(parseAnchor(body)).toEqual({ exact: "foo", prefix: "a ", suffix: " b" });
  });

  test("returns null when no marker present", () => {
    expect(parseAnchor("plain comment")).toBeNull();
    expect(parseAnchor("> still no marker\n\nbody")).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    expect(parseAnchor("<!-- nr:v1 {bogus} -->")).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    expect(parseAnchor(`<!-- nr:v1 {"exact":"foo"} -->`)).toBeNull();
    expect(parseAnchor(`<!-- nr:v1 {"prefix":"","suffix":""} -->`)).toBeNull();
  });

  test("tolerates whitespace around the marker", () => {
    const body = `<!--   nr:v1   {"exact":"x","prefix":"","suffix":""}  -->`;
    expect(parseAnchor(body)).toEqual({ exact: "x", prefix: "", suffix: "" });
  });
});

describe("stripAnchorFromBody", () => {
  test("removes both the marker and the leading blockquote", () => {
    const body = `> "phrase"\n\nactual comment\n\n<!-- nr:v1 {"exact":"phrase","prefix":"","suffix":""} -->`;
    expect(stripAnchorFromBody(body)).toBe("actual comment");
  });

  test("leaves an unmarked body unchanged", () => {
    expect(stripAnchorFromBody("plain comment")).toBe("plain comment");
  });

  test("leaves a non-anchor blockquote alone", () => {
    // The strip regex only catches a single-line `> "..."` pattern; longer
    // blockquotes are user content and should pass through.
    const body = `> regular blockquote\n> with two lines\n\nbody`;
    expect(stripAnchorFromBody(body)).toBe(body);
  });
});

describe("buildCommentBody", () => {
  test("wraps body with quote and marker when anchor is present", () => {
    const anchor: Anchor = { exact: "phrase", prefix: "", suffix: "" };
    const out = buildCommentBody("the comment", anchor);
    expect(out).toContain('> "phrase"');
    expect(out).toContain("the comment");
    expect(out).toContain("<!-- nr:v1 ");
    expect(out).toContain('"exact":"phrase"');
  });

  test("returns body unchanged when anchor is null", () => {
    expect(buildCommentBody("hello", null)).toBe("hello");
  });

  test("collapses internal whitespace in quoted exact", () => {
    const anchor: Anchor = { exact: "two\n\nlines", prefix: "", suffix: "" };
    const out = buildCommentBody("c", anchor);
    expect(out).toContain('> "two lines"');
  });

  test("round-trips through parseAnchor", () => {
    const anchor: Anchor = { exact: "phrase", prefix: "before ", suffix: " after" };
    const body = buildCommentBody("the comment", anchor);
    expect(parseAnchor(body)).toEqual(anchor);
    expect(stripAnchorFromBody(body)).toBe("the comment");
  });
});

// ---- DOM-backed suites -------------------------------------------------------

function buildProse(html: string): { proseRoot: HTMLElement; block: HTMLElement } {
  document.body.innerHTML = "";
  const proseRoot = document.createElement("div");
  proseRoot.className = "prose";
  document.body.appendChild(proseRoot);

  // Wrap the supplied HTML in a paragraph carrying the line-anchor data attrs
  // that captureAnchorFromRange / findAnchorRange look for.
  const p = document.createElement("p");
  p.dataset.lineStart = "1";
  p.dataset.lineEnd = "1";
  p.innerHTML = html;
  proseRoot.appendChild(p);
  return { proseRoot, block: p };
}

/**
 * Build a Range that spans `[start, end)` character offsets within the block's
 * text content. Useful for simulating a drag selection in tests.
 */
function rangeAt(block: HTMLElement, start: number, end: number): Range {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);

  const locate = (offset: number): { node: Text; off: number } => {
    let acc = 0;
    for (const tn of textNodes) {
      const len = tn.data.length;
      if (offset <= acc + len) return { node: tn, off: offset - acc };
      acc += len;
    }
    const last = textNodes[textNodes.length - 1];
    return { node: last, off: last.data.length };
  };

  const s = locate(start);
  const e = locate(end);
  const r = document.createRange();
  r.setStart(s.node, s.off);
  r.setEnd(e.node, e.off);
  return r;
}

describe("captureAnchorFromRange", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("clean selection produces a strict prefix/exact/suffix triple", () => {
    const text =
      "could veto every financing amendment. No serious acquirer wanted to inherit a fragmented royalty pool";
    const { proseRoot, block } = buildProse(text);
    const start = text.indexOf("No");
    const end = start + "No serious acquirer wanted".length;
    const range = rangeAt(block, start, end);

    const a = captureAnchorFromRange(range, proseRoot);
    expect(a).not.toBeNull();
    expect(a!.exact).toBe("No serious acquirer wanted");
    // Reconstruction must be a substring of the block's text:
    expect(text.includes(a!.prefix + a!.exact + a!.suffix)).toBe(true);
  });

  test("INVARIANT: selection that begins on a leading space still reconstructs", () => {
    // This is the bug the user hit. If a drag begins ON the space before a
    // word, range.toString() = " word"; trimming `exact` to "word" must shift
    // the lost space into the prefix or the matcher will miss strictly.
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const { proseRoot, block } = buildProse(text);
    const start = text.indexOf(" gamma"); // begin ON the space
    const end = start + " gamma".length;
    const range = rangeAt(block, start, end);

    const a = captureAnchorFromRange(range, proseRoot);
    expect(a).not.toBeNull();
    // exact is trimmed:
    expect(a!.exact).toBe("gamma");
    // The lost leading space rides on the prefix:
    expect(a!.prefix.endsWith(" ")).toBe(true);
    // Lossless invariant holds:
    expect(text.includes(a!.prefix + a!.exact + a!.suffix)).toBe(true);
  });

  test("INVARIANT: trailing whitespace is moved into suffix", () => {
    const text = "one two three four five six seven eight nine ten";
    const { proseRoot, block } = buildProse(text);
    const start = text.indexOf("three");
    const end = start + "three ".length; // include trailing space
    const range = rangeAt(block, start, end);

    const a = captureAnchorFromRange(range, proseRoot);
    expect(a).not.toBeNull();
    expect(a!.exact).toBe("three");
    expect(a!.suffix.startsWith(" ")).toBe(true);
    expect(text.includes(a!.prefix + a!.exact + a!.suffix)).toBe(true);
  });

  test("INVARIANT: leading and trailing whitespace simultaneously", () => {
    const text = "first second third fourth fifth sixth seventh eighth ninth";
    const { proseRoot, block } = buildProse(text);
    const start = text.indexOf("second") - 1; // leading space
    const end = text.indexOf("fourth"); // up to (not including) "fourth"
    const range = rangeAt(block, start, end);

    const a = captureAnchorFromRange(range, proseRoot);
    expect(a).not.toBeNull();
    expect(a!.exact).toBe("second third");
    expect(text.includes(a!.prefix + a!.exact + a!.suffix)).toBe(true);
  });

  test("returns null when the trimmed exact is too short", () => {
    const text = "a b c d e f g h i j";
    const { proseRoot, block } = buildProse(text);
    // Whitespace-only selection: just the space between "a" and "b".
    const start = 1;
    const end = 2;
    const range = rangeAt(block, start, end);
    expect(captureAnchorFromRange(range, proseRoot)).toBeNull();
  });

  test("returns null when range isn't inside a line block", () => {
    document.body.innerHTML = "";
    const proseRoot = document.createElement("div");
    proseRoot.className = "prose";
    const stray = document.createElement("div");
    stray.appendChild(document.createTextNode("stray text outside any block"));
    proseRoot.appendChild(stray);
    document.body.appendChild(proseRoot);

    const r = document.createRange();
    r.setStart(stray.firstChild!, 0);
    r.setEnd(stray.firstChild!, 5);
    expect(captureAnchorFromRange(r, proseRoot)).toBeNull();
  });
});

describe("findAnchorRange", () => {
  test("strict (word) match locates exact via prefix+exact+suffix", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const { block } = buildProse(text);

    const result = findAnchorRange([block], {
      exact: "brown fox",
      prefix: "quick ",
      suffix: " jumps",
    });

    expect(result).not.toBeNull();
    expect(result!.match).toBe("word");
    // Verify the returned range actually points at "brown fox":
    const r = document.createRange();
    r.setStart(result!.startNode, result!.startOffset);
    r.setEnd(result!.endNode, result!.endOffset);
    expect(r.toString()).toBe("brown fox");
  });

  test("falls back to recovered when prefix/suffix don't match but exact does", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const { block } = buildProse(text);

    const result = findAnchorRange([block], {
      exact: "brown fox",
      prefix: "different ",
      suffix: " context",
    });

    expect(result).not.toBeNull();
    expect(result!.match).toBe("recovered");
    const r = document.createRange();
    r.setStart(result!.startNode, result!.startOffset);
    r.setEnd(result!.endNode, result!.endOffset);
    expect(r.toString()).toBe("brown fox");
  });

  test("REGRESSION: empty prefix AND empty suffix is a clean word match, not recovered", () => {
    // When the user selects from the very start of a block to the very end,
    // there's no context to capture - prefix="" and suffix="". The matcher
    // used to skip the composite branch and tag the bare-exact result as
    // `recovered`, even though no recovery was happening.
    const text = "the quick brown fox jumps over the lazy dog";
    const { block } = buildProse(text);

    const result = findAnchorRange([block], {
      exact: text,
      prefix: "",
      suffix: "",
    });

    expect(result).not.toBeNull();
    expect(result!.match).toBe("word");
  });

  test("returns null when exact isn't anywhere in the haystack", () => {
    const { block } = buildProse("nothing relevant here");
    expect(
      findAnchorRange([block], { exact: "absent", prefix: "", suffix: "" }),
    ).toBeNull();
  });

  test("multi-block exact: caller can detect cross-block via parent ancestry", () => {
    // Multi-line PR comments produce anchors whose `exact` spans multiple
    // paragraphs. We don't expose a flag on the result, but the walker can
    // detect the cross-block case by checking `startNode` and `endNode`'s
    // closest [data-line-start] ancestor. If they differ, the caller MUST
    // bail rather than wrap the range in a <mark>: surroundContents throws,
    // and extractContents would split paragraphs and leave empty <p> shells
    // behind (see "duplicate line 3" rendering bug).
    document.body.innerHTML = "";
    const proseRoot = document.createElement("div");
    proseRoot.className = "prose";
    document.body.appendChild(proseRoot);
    const mkBlock = (n: number, text: string) => {
      const p = document.createElement("p");
      p.dataset.lineStart = String(n);
      p.dataset.lineEnd = String(n);
      p.textContent = text;
      proseRoot.appendChild(p);
      return p;
    };
    const p3 = mkBlock(3, "The week before Christmas 2022, two doors opened.");
    const p5 = mkBlock(5, "The first was already open. Securly bought e-hallpass.");
    const p7 = mkBlock(7, "The second door opened on December 6,");

    // exact spans p3..p7 (the way captured ranges look on a multi-paragraph drag)
    const result = findAnchorRange([p3, p5, p7], {
      exact:
        "The week before Christmas 2022, two doors opened.\nThe first was already open. Securly bought e-hallpass.\nThe second door opened on December 6,",
      prefix: "",
      suffix: "",
    });
    expect(result).not.toBeNull();
    const startBlock = (result!.startNode.parentElement as HTMLElement).closest(
      "[data-line-start]",
    );
    const endBlock = (result!.endNode.parentElement as HTMLElement).closest(
      "[data-line-start]",
    );
    expect(startBlock).toBe(p3);
    expect(endBlock).toBe(p7);
    expect(startBlock === endBlock).toBe(false);
  });

  test("uses prefix+suffix to disambiguate when exact appears multiple times", () => {
    const text = "alpha beta alpha gamma alpha delta";
    const { block } = buildProse(text);

    const result = findAnchorRange([block], {
      exact: "alpha",
      prefix: "beta ",
      suffix: " gamma",
    });
    expect(result).not.toBeNull();
    expect(result!.match).toBe("word");
    const r = document.createRange();
    r.setStart(result!.startNode, result!.startOffset);
    r.setEnd(result!.endNode, result!.endOffset);
    // Should be the SECOND "alpha" (the one between beta and gamma):
    expect(text.indexOf("alpha", text.indexOf("alpha") + 1)).toBe(
      text.slice(0, text.indexOf("alpha", text.indexOf("alpha") + 1)).length,
    );
    expect(r.toString()).toBe("alpha");
  });
});

// ---- End-to-end round-trip ---------------------------------------------------

describe("capture → find round-trip", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("any drag in plain text produces a strict (word) match", () => {
    const text =
      "could veto every financing amendment. No serious acquirer wanted to inherit a fragmented royalty pool";
    const { proseRoot, block } = buildProse(text);
    const start = text.indexOf("No");
    const end = start + "No serious acquirer wanted".length;
    const range = rangeAt(block, start, end);
    const anchor = captureAnchorFromRange(range, proseRoot)!;

    const result = findAnchorRange([block], anchor);
    expect(result).not.toBeNull();
    expect(result!.match).toBe("word");
  });

  test("REGRESSION: drag begins on leading space → still resolves to word", () => {
    // The exact scenario behind the user-reported "RECOVERED" bug.
    const text =
      "could veto every financing amendment. No serious acquirer wanted to inherit a fragmented royalty pool";
    const { proseRoot, block } = buildProse(text);
    // Drag starts ON the space before "No" (offset of " ", not "N").
    const start = text.indexOf(" No serious");
    const end = text.indexOf("No serious") + "No serious acquirer wanted".length;
    const range = rangeAt(block, start, end);
    const anchor = captureAnchorFromRange(range, proseRoot)!;
    expect(anchor.exact).toBe("No serious acquirer wanted");

    const result = findAnchorRange([block], anchor);
    expect(result).not.toBeNull();
    expect(result!.match).toBe("word");
  });

  test("REGRESSION: drag ends on trailing space → still resolves to word", () => {
    const text =
      "could veto every financing amendment. No serious acquirer wanted to inherit a fragmented royalty pool";
    const { proseRoot, block } = buildProse(text);
    const start = text.indexOf("No serious");
    const end = text.indexOf("wanted ") + "wanted ".length; // include trailing space
    const range = rangeAt(block, start, end);
    const anchor = captureAnchorFromRange(range, proseRoot)!;
    expect(anchor.exact).toBe("No serious acquirer wanted");

    const result = findAnchorRange([block], anchor);
    expect(result).not.toBeNull();
    expect(result!.match).toBe("word");
  });
});
