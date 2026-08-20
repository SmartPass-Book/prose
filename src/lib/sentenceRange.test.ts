import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Bun runs every test file in one process, so whichever DOM-using suite loads
// second would throw on a repeat registration.
if (typeof document === "undefined") GlobalRegistrator.register();

import { describe, expect, it } from "bun:test";
import { findSentenceRange } from "./sentenceRange";

function block(html: string): HTMLElement {
  const el = document.createElement("p");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("findSentenceRange", () => {
  it("finds a sentence that wrapped across source lines", () => {
    // The case this exists for: speech.ts collapsed the newline to a space, so
    // a plain indexOf against the rendered text would miss.
    const el = block("She walked out.\nThe rain had not stopped.");
    const range = findSentenceRange(el, "The rain had not stopped.");
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe("The rain had not stopped.");
  });

  it("spans inline markup", () => {
    const el = block("She was <em>certain</em> it was the same door.");
    const range = findSentenceRange(el, "She was certain it was the same door.");
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe("She was certain it was the same door.");
  });

  it("picks the right sentence out of a paragraph", () => {
    const el = block("One. Two. Three.");
    const range = findSentenceRange(el, "Two.");
    expect(range!.toString()).toBe("Two.");
    expect(range!.startOffset).toBe(5);
  });

  it("tolerates collapsed runs of whitespace", () => {
    // The range covers the raw characters, which still hold the run - it is the
    // browser that renders them as one space. So the comparison normalizes too.
    const el = block("Morning   came.\n\n  It was quiet.");
    const collapse = (r: Range | null) => r!.toString().replace(/\s+/g, " ");
    expect(collapse(findSentenceRange(el, "Morning came."))).toBe("Morning came.");
    expect(collapse(findSentenceRange(el, "It was quiet."))).toBe("It was quiet.");
  });

  it("returns null when the text is not in the block", () => {
    expect(findSentenceRange(block("Morning came."), "Evening fell.")).toBeNull();
  });

  it("returns null for an empty sentence rather than matching everything", () => {
    expect(findSentenceRange(block("Morning came."), "   ")).toBeNull();
  });

  it("does not run past the end of the match", () => {
    // A regression guard: taking the origin of the character *after* the match
    // would swallow a following whitespace run.
    const el = block("Alpha beta.    Gamma.");
    expect(findSentenceRange(el, "Alpha beta.")!.toString()).toBe("Alpha beta.");
  });
});
