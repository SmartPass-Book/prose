import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../types";
import { friendlyOutboxError, threadsEqual } from "./reviewSync";

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "thread-1",
    clientKey: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "README.md",
    line: 4,
    startLine: null,
    originalLine: 4,
    diffSide: "RIGHT",
    comments: {
      nodes: [
        {
          id: "comment-1",
          databaseId: 1,
          body: "Looks good",
          author: { login: "reviewer" },
          createdAt: "2026-01-01T00:00:00Z",
          url: "https://example.test/comment-1",
        },
      ],
    },
    ...overrides,
  };
}

describe("threadsEqual", () => {
  test("accepts equivalent thread snapshots", () => {
    expect(threadsEqual([thread()], [thread()])).toBe(true);
  });

  test("detects thread and comment changes", () => {
    expect(threadsEqual([thread()], [thread({ isResolved: true })])).toBe(false);
    expect(
      threadsEqual(
        [thread()],
        [thread({ comments: { nodes: [{ ...thread().comments.nodes[0], body: "Changed" }] } })],
      ),
    ).toBe(false);
  });
});

describe("friendlyOutboxError", () => {
  test("explains invalid review lines", () => {
    expect(friendlyOutboxError("422 line is not part of the diff")).toContain(
      "only go on lines",
    );
  });

  test("truncates unknown errors", () => {
    expect(friendlyOutboxError("x".repeat(200))).toHaveLength(160);
  });
});
