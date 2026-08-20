import { describe, expect, it } from "bun:test";
import {
  MAX_CHUNK_CHARS,
  extractSpeakable,
  frontMatterEndLine,
  splitSentences,
  utteranceForLine,
} from "./speech";

const spoken = (markdown: string) =>
  extractSpeakable(markdown).utterances.map((u) => u.text);

describe("frontMatterEndLine", () => {
  it("finds the closing fence", () => {
    expect(frontMatterEndLine("---\ntitle: Chapter One\nstatus: draft\n---\n\nText.")).toBe(4);
  });

  it("ignores a horizontal rule that is not at the top of the file", () => {
    expect(frontMatterEndLine("Some prose.\n\n---\n\nMore prose.")).toBe(0);
  });

  it("does not swallow the document when the fence is never closed", () => {
    expect(frontMatterEndLine("---\ntitle: unterminated\n\nProse.")).toBe(0);
  });
});

describe("extractSpeakable", () => {
  it("reads headings, paragraphs and blockquotes", () => {
    const md = "# The Long Road\n\nShe walked.\n\n> He did not follow.\n";
    expect(spoken(md)).toEqual(["The Long Road", "She walked.", "He did not follow."]);
  });

  it("keeps line numbers aligned with the rendered blocks", () => {
    // These are the numbers the renderer stamps as data-line-start, taken from
    // the same mdast positions. If they drift, the gutter play button plays the
    // wrong paragraph.
    const md = "# Title\n\nFirst paragraph\nwrapping two lines.\n\nSecond paragraph.\n";
    const { blocks } = extractSpeakable(md);
    expect(blocks.map((b) => [b.kind, b.lineStart, b.lineEnd])).toEqual([
      ["heading", 1, 1],
      ["paragraph", 3, 4],
      ["paragraph", 6, 6],
    ]);
  });

  it("uses the inner paragraph's line range for a blockquote", () => {
    // App.css notes that a blockquote renders its inner <p> as a nested
    // [data-line-start]; that inner element is what the reader hovers.
    const md = "Before.\n\n> Quoted line one.\n> Quoted line two.\n";
    const { blocks } = extractSpeakable(md);
    expect(blocks[1].lineStart).toBe(3);
    expect(blocks[1].lineEnd).toBe(4);
  });

  it("skips front matter instead of reading the fields aloud", () => {
    const md = "---\ntitle: Chapter One\npov: Mira\n---\n\nThe rain started.\n";
    expect(spoken(md)).toEqual(["The rain started."]);
  });

  it("never reads an HTML comment, including the nr:v1 anchor markers", () => {
    // The failure this guards: the marker's JSON body being spelled out.
    const md =
      "<!-- nr:v1 {\"exact\":\"the rain\",\"prefix\":\"\",\"suffix\":\"\"} -->\n\n" +
      "The rain started. <!-- inline note --> It did not stop.\n";
    expect(spoken(md).join(" ")).not.toContain("nr:v1");
    expect(spoken(md).join(" ")).not.toContain("exact");
    expect(spoken(md)).toEqual(["The rain started.", "It did not stop."]);
  });

  it("skips images and their alt text", () => {
    const md = "![A map of the northern reach](assets/chapter-02/map.svg)\n\nShe studied it.\n";
    expect(spoken(md)).toEqual(["She studied it."]);
  });

  it("keeps the prose around an inline image without reading the image", () => {
    const md = "She held ![the locket](assets/locket.png) up to the light.\n";
    expect(spoken(md)).toEqual(["She held up to the light."]);
  });

  it("skips code blocks and tables", () => {
    const md =
      "Prose before.\n\n```json\n{\"do\": \"not read me\"}\n```\n\n" +
      "| a | b |\n| - | - |\n| 1 | 2 |\n\nProse after.\n";
    expect(spoken(md)).toEqual(["Prose before.", "Prose after."]);
  });

  it("drops footnote markers but keeps the sentence", () => {
    const md = "The treaty held.[^1]\n\n[^1]: Not for long.\n";
    expect(spoken(md)).toEqual(["The treaty held."]);
  });

  it("reads the text of emphasis and links, not their markup", () => {
    const md = "She was *certain* it was [the same door](https://example.com/door).\n";
    expect(spoken(md)).toEqual(["She was certain it was the same door."]);
  });

  it("turns a scene break into a pause rather than a word", () => {
    const md = "The door closed.\n\n---\n\nMorning came.\n";
    const { utterances } = extractSpeakable(md);
    expect(utterances.map((u) => u.text)).toEqual(["The door closed.", "Morning came."]);
    // The break lands as silence on the utterance before it.
    expect(utterances[0].pauseAfterMs).toBeGreaterThan(utterances[1].pauseAfterMs);
  });

  it("reads list items", () => {
    const md = "She packed:\n\n- a knife\n- three coins\n";
    expect(spoken(md)).toEqual(["She packed:", "a knife", "three coins"]);
  });

  it("gives every utterance offsets into its own block's text", () => {
    const md = "One sentence. Two sentence.\n";
    const { blocks, utterances } = extractSpeakable(md);
    for (const u of utterances) {
      const block = blocks[u.block];
      expect(block.text.slice(u.charStart, u.charEnd).trim()).toBe(u.text);
    }
  });

  it("produces no empty utterances", () => {
    const md = "# Title\n\n![](a.png)\n\n---\n\nText.\n\n> \n\nMore.\n";
    for (const u of extractSpeakable(md).utterances) {
      expect(u.text.length).toBeGreaterThan(0);
    }
  });
});

describe("splitSentences", () => {
  it("splits on terminators", () => {
    expect(splitSentences("She ran. He stayed! Why?").map((s) => s.text)).toEqual([
      "She ran.",
      "He stayed!",
      "Why?",
    ]);
  });

  it("keeps a dialogue tag with its quotation", () => {
    // The bias reversal: a lowercase word after a terminator means the sentence
    // is still going.
    expect(splitSentences('"Are you sure?" she asked.').map((s) => s.text)).toEqual([
      '"Are you sure?" she asked.',
    ]);
  });

  it("splits after a closing quote when a new sentence follows", () => {
    expect(splitSentences('"Go away." He did not move.').map((s) => s.text)).toEqual([
      '"Go away."',
      "He did not move.",
    ]);
  });

  it("does not split inside a decimal or a domain", () => {
    expect(splitSentences("It cost 3.5 marks at example.com that year.")).toHaveLength(1);
  });

  it("does not split after a title or an initial", () => {
    expect(splitSentences("Dr. Aldous met Mr. Vane.").map((s) => s.text)).toEqual([
      "Dr. Aldous met Mr. Vane.",
    ]);
    expect(splitSentences("J. R. R. Tolkien wrote it.")).toHaveLength(1);
    expect(splitSentences("Bring rope, e.g. the long coil.")).toHaveLength(1);
  });

  it("does not split mid-sentence on an ellipsis", () => {
    expect(splitSentences("He paused... then spoke.")).toHaveLength(1);
  });

  it("returns offsets that address the original string", () => {
    const text = "She ran. He stayed.";
    for (const span of splitSentences(text)) {
      expect(text.slice(span.start, span.end).trim()).toBe(span.text);
    }
  });
});

describe("chunk length", () => {
  it("breaks a sentence that would blow the token ceiling", () => {
    // One sentence, no terminator to split on, well over the cap.
    const long = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ") + ".";
    const { utterances } = extractSpeakable(long);
    expect(utterances.length).toBeGreaterThan(1);
    for (const u of utterances) {
      expect(u.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    // Nothing may be lost in the break.
    expect(utterances.map((u) => u.text).join(" ")).toBe(long);
  });

  it("prefers a clause boundary when breaking", () => {
    const head = "a".repeat(200);
    const tail = "b".repeat(200);
    const { utterances } = extractSpeakable(`${head}; ${tail}.`);
    expect(utterances[0].text.endsWith(";")).toBe(true);
  });
});

describe("utteranceForLine", () => {
  const md = "# Title\n\nFirst.\n\n![](a.png)\n\nSecond.\n";

  it("finds the utterance for a block's own line", () => {
    const doc = extractSpeakable(md);
    expect(doc.utterances[utteranceForLine(doc, 3)!].text).toBe("First.");
  });

  it("falls forward past an unspeakable block", () => {
    // Line 5 is the figure. Clicking its gutter should start at the prose after
    // it, not silently do nothing.
    const doc = extractSpeakable(md);
    expect(doc.utterances[utteranceForLine(doc, 5)!].text).toBe("Second.");
  });

  it("returns null past the end of the document", () => {
    expect(utteranceForLine(extractSpeakable(md), 99)).toBeNull();
  });
});
