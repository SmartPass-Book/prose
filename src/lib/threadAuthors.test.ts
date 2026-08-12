import { describe, expect, it } from "bun:test";
import { isOwnThread } from "./threadAuthors";
import type { ReviewComment, ReviewThread } from "../types";

function comment(login: string, overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: `c-${login}`,
    databaseId: 1,
    body: "note",
    author: { login },
    createdAt: "2026-07-22T12:00:00Z",
    url: "",
    ...overrides,
  };
}

function thread(logins: string[]): ReviewThread {
  return {
    id: "T1",
    clientKey: "ck1",
    isResolved: false,
    isOutdated: false,
    path: "story/chapter-01.md",
    line: 4,
    startLine: null,
    originalLine: 4,
    diffSide: "RIGHT",
    comments: { nodes: logins.map((login) => comment(login)) },
  };
}

describe("isOwnThread", () => {
  it("keeps a thread the user started", () => {
    expect(isOwnThread(thread(["me", "them"]), "me")).toBe(true);
  });

  it("keeps a thread the user only replied to", () => {
    expect(isOwnThread(thread(["them", "me"]), "me")).toBe(true);
  });

  it("drops a thread written entirely by other people", () => {
    expect(isOwnThread(thread(["them", "someone-else"]), "me")).toBe(false);
  });

  it("fails open before the login resolves", () => {
    expect(isOwnThread(thread(["them"]), null)).toBe(true);
  });

  it("matches logins exactly rather than by prefix", () => {
    expect(isOwnThread(thread(["mercury"]), "me")).toBe(false);
  });

  it("keeps an optimistic row, which carries the cached login", () => {
    const optimistic = thread([]);
    optimistic.comments.nodes = [comment("me", { pendingOp: "op-1" })];
    expect(isOwnThread(optimistic, "me")).toBe(true);
  });
});
