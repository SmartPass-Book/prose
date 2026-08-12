import { describe, expect, it } from "bun:test";
import { isExternalUrl, resolveRepoPath } from "./repoPaths";

describe("resolveRepoPath", () => {
  it("resolves against the referencing file's directory", () => {
    // The case that shipped broken: a chapter figure referenced relatively.
    expect(
      resolveRepoPath(
        "story/abridged/chapter-02.md",
        "assets/chapter-02/request-electronic-hall-passes.svg",
      ),
    ).toBe("story/abridged/assets/chapter-02/request-electronic-hall-passes.svg");
  });

  it("collapses . and .. segments", () => {
    expect(resolveRepoPath("story/abridged/chapter-02.md", "./figs/a.png")).toBe(
      "story/abridged/figs/a.png",
    );
    expect(resolveRepoPath("story/abridged/chapter-02.md", "../shared/a.png")).toBe(
      "story/shared/a.png",
    );
    // Two levels up from story/abridged/planning/ is story/.
    expect(
      resolveRepoPath("story/abridged/planning/notes.md", "../../top.png"),
    ).toBe("story/top.png");
  });

  it("treats a leading slash as the repo root, not the filesystem root", () => {
    expect(resolveRepoPath("story/abridged/chapter-02.md", "/logo.png")).toBe(
      "logo.png",
    );
    expect(
      resolveRepoPath("story/abridged/chapter-02.md", "/story/assets/a.png"),
    ).toBe("story/assets/a.png");
  });

  it("cannot climb above the repo root", () => {
    expect(resolveRepoPath("chapter.md", "../../../etc/passwd")).toBe(
      "etc/passwd",
    );
  });

  it("strips query strings and fragments", () => {
    expect(resolveRepoPath("a/b.md", "img.png?v=2")).toBe("a/img.png");
    expect(resolveRepoPath("a/b.md", "img.png#frag")).toBe("a/img.png");
  });

  it("handles a file at the repo root", () => {
    expect(resolveRepoPath("README.md", "docs/a.png")).toBe("docs/a.png");
  });
});

describe("isExternalUrl", () => {
  it("recognizes what the webview can already load", () => {
    expect(isExternalUrl("https://example.com/a.png")).toBe(true);
    expect(isExternalUrl("http://example.com/a.png")).toBe(true);
    expect(isExternalUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isExternalUrl("//example.com/a.png")).toBe(true);
  });

  it("treats repo-relative paths as needing a fetch", () => {
    expect(isExternalUrl("assets/a.png")).toBe(false);
    expect(isExternalUrl("./a.png")).toBe(false);
    expect(isExternalUrl("../a.png")).toBe(false);
    expect(isExternalUrl("/a.png")).toBe(false);
  });
});
