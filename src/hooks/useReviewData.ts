import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import type { Toast } from "../components";
import type { Anchor } from "../lib/anchors";
import { buildCommentBody } from "../lib/anchors";
import { friendlyOutboxError, threadsEqual } from "../lib/reviewSync";
import { api } from "../services/api";
import type { PR, PRSummary, ReviewThread } from "../types";
import type { LineRange } from "../components/reviewTypes";

interface UseReviewDataOptions {
  repo: string;
  unwrapMarks: () => void;
  pushToast: (toast: Omit<Toast, "id">) => string;
  reportError: (error: unknown, title?: string) => void;
}

export function useReviewData({
  repo,
  unwrapMarks,
  pushToast,
  reportError,
}: UseReviewDataOptions) {
  const [prs, setPRs] = useState<PRSummary[]>([]);
  const [selectedPR, setSelectedPR] = useState<PR | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [, setNowTick] = useState(0);

  const loadPRs = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const list = force ? await api.refreshPRs(repo) : await api.listPRs(repo);
        setPRs(list);
      } catch (error) {
        reportError(error, "Couldn't load pull requests");
      } finally {
        setLoading(false);
      }
    },
    [repo, reportError],
  );

  useEffect(() => {
    void loadPRs();
    api.getCurrentUser().then(setCurrentUser).catch(() => {});
  }, [loadPRs]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("log://line", (event) => {
      console.log(
        "%c[rust]%c " + event.payload,
        "color:#c08a00;font-weight:bold",
        "",
      );
    }).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNowTick((tick) => tick + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedPR) {
      void api.setActivePR(null, null).catch(() => {});
      return;
    }
    void api.setActivePR(repo, selectedPR.number).catch(() => {});
    return () => {
      void api.setActivePR(null, null).catch(() => {});
    };
  }, [selectedPR, repo]);

  useEffect(() => {
    const sendFocus = () => {
      void api.setFocus(document.visibilityState === "visible").catch(() => {});
    };
    sendFocus();
    document.addEventListener("visibilitychange", sendFocus);
    return () => document.removeEventListener("visibilitychange", sendFocus);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ repo: string; number: number; headRefOid: string }>(
      "cache:pr-updated",
      async (event) => {
        if (!selectedPR) return;
        if (event.payload.repo !== repo || event.payload.number !== selectedPR.number) return;
        if (event.payload.headRefOid === selectedPR.headRefOid) return;
        try {
          const pullRequest = await api.getPR(repo, selectedPR.number);
          setSelectedPR(pullRequest);
          if (activeFile) {
            const content = await api.getFile(repo, pullRequest.headRefOid, activeFile);
            unwrapMarks();
            setFileContent(content);
          }
        } catch {
          // Background refresh failures are surfaced by the next explicit refresh.
        }
      },
    ).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, [activeFile, repo, selectedPR, unwrapMarks]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ opId: string; kind: string; error: string; attempts: number }>(
      "outbox:failed",
      (event) => {
        const { opId, kind, error } = event.payload;
        const label =
          kind === "post_comment"
            ? "Comment"
            : kind === "reply"
              ? "Reply"
              : kind === "delete_comment"
                ? "Delete"
                : "Change";
        const recoverable = kind === "post_comment" || kind === "reply";
        pushToast({
          kind: "error",
          title: `${label} couldn't be saved to GitHub`,
          detail: recoverable
            ? `${friendlyOutboxError(error)} Your text is kept in the sidebar.`
            : friendlyOutboxError(error),
          actions: recoverable
            ? [
                {
                  label: "Retry",
                  primary: true,
                  onClick: () => {
                    void api.retryOutboxOp(opId).catch((retryError) =>
                      reportError(retryError),
                    );
                  },
                },
                {
                  label: "Discard",
                  onClick: () => {
                    void api.discardOutboxOp(opId).catch((discardError) =>
                      reportError(discardError),
                    );
                  },
                },
              ]
            : undefined,
          timeoutMs: recoverable ? undefined : 10000,
        });
      },
    ).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, [pushToast, reportError]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ repo: string; number: number }>(
      "cache:threads-updated",
      async (event) => {
        if (!selectedPR) return;
        if (event.payload.repo !== repo || event.payload.number !== selectedPR.number) return;
        try {
          const fetched = await api.getThreads(repo, selectedPR.number);
          setThreads((current) => (threadsEqual(current, fetched) ? current : fetched));
        } catch {
          // Background polling retries automatically.
        }
      },
    ).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, [repo, selectedPR]);

  const postCommentForRange = useCallback(
    async (range: LineRange, anchor: Anchor | null, body: string) => {
      if (!selectedPR || !activeFile) return;
      try {
        const clientKey = crypto.randomUUID();
        await api.mutatePostComment({
          repo,
          number: selectedPR.number,
          commitId: selectedPR.headRefOid,
          path: activeFile,
          line: range.end,
          startLine: range.start === range.end ? undefined : range.start,
          body: buildCommentBody(body, anchor, clientKey),
          clientKey,
        });
      } catch (error) {
        reportError(error, "Couldn't queue comment");
      }
    },
    [activeFile, repo, selectedPR, reportError],
  );

  const openPR = useCallback(
    async (number: number, options?: { preferFile?: string | null }) => {
      setLoading(true);
      try {
        const [pullRequest, threadList] = await Promise.all([
          api.getPR(repo, number),
          api.getThreads(repo, number),
        ]);
        const counts = new Map<string, number>();
        for (const thread of threadList) {
          if (!thread.isResolved) {
            counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
          }
        }
        const sortedFiles = [...pullRequest.files].sort(
          (left, right) =>
            (counts.get(right.path) ?? 0) - (counts.get(left.path) ?? 0) ||
            left.path.localeCompare(right.path),
        );
        const preferred = options?.preferFile
          ? sortedFiles.find((file) => file.path === options.preferFile)
          : undefined;
        const initial =
          preferred ??
          sortedFiles.find((file) => (counts.get(file.path) ?? 0) > 0) ??
          sortedFiles.find((file) => file.path.endsWith(".md")) ??
          sortedFiles[0];
        const content = initial
          ? await api.getFile(repo, pullRequest.headRefOid, initial.path)
          : "";
        setSelectedPR(pullRequest);
        setActiveFile(initial?.path ?? null);
        unwrapMarks();
        setFileContent(content);
        setThreads(threadList);
        const fetchedAt = await api.getPRFetchedAt(repo, number);
        setLastRefreshAt(fetchedAt ? new Date(fetchedAt) : new Date());
      } catch (error) {
        reportError(error, `Couldn't open PR #${number}`);
      } finally {
        setLoading(false);
      }
    },
    [repo, reportError, unwrapMarks],
  );

  const refreshPRList = useCallback(async () => {
    try {
      setPRs(await api.refreshPRs(repo));
    } catch (error) {
      reportError(error, "Couldn't refresh PR list");
    }
  }, [repo, reportError]);

  const refreshActivePR = useCallback(async () => {
    if (!selectedPR) return;
    setRefreshing(true);
    try {
      await api.clearPrCache(repo, selectedPR.number);
      await openPR(selectedPR.number, { preferFile: activeFile });
    } catch (error) {
      reportError(error, "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, [activeFile, openPR, repo, selectedPR, reportError]);

  useEffect(() => {
    const onReload = (event: KeyboardEvent) => {
      if (event.key !== "r" || !(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      void refreshActivePR();
    };
    window.addEventListener("keydown", onReload);
    return () => window.removeEventListener("keydown", onReload);
  }, [refreshActivePR]);

  const switchFile = useCallback(
    async (path: string) => {
      if (!selectedPR) return;
      setActiveFile(path);
      unwrapMarks();
      setFileContent("");
      try {
        const content = await api.getFile(repo, selectedPR.headRefOid, path);
        unwrapMarks();
        setFileContent(content);
      } catch (error) {
        reportError(error, "Couldn't load file");
      }
    },
    [repo, selectedPR, unwrapMarks, reportError],
  );

  const toggleResolve = useCallback(
    async (thread: ReviewThread) => {
      try {
        await api.mutateResolve(thread.clientKey, !thread.isResolved);
      } catch (error) {
        reportError(error, "Couldn't update thread");
      }
    },
    [reportError],
  );

  const deleteComment = useCallback(
    async (commentId: number) => {
      try {
        await api.mutateDeleteComment(repo, commentId);
      } catch (error) {
        reportError(error, "Couldn't delete comment");
      }
    },
    [repo, reportError],
  );

  const replyTo = useCallback(
    async (thread: ReviewThread, body: string) => {
      if (!selectedPR) return;
      const first = thread.comments.nodes[0];
      if (!first) return;
      try {
        const clientKey = crypto.randomUUID();
        await api.mutateReply({
          threadId: thread.clientKey,
          repo,
          number: selectedPR.number,
          inReplyTo: first.databaseId,
          body: buildCommentBody(body, null, clientKey),
          clientKey,
        });
      } catch (error) {
        reportError(error, "Couldn't queue reply");
      }
    },
    [repo, selectedPR, reportError],
  );

  const retryOp = useCallback(
    (opId: string) => {
      void api.retryOutboxOp(opId).catch((error) => reportError(error, "Retry failed"));
    },
    [reportError],
  );

  const discardOp = useCallback(
    (opId: string) => {
      void api
        .discardOutboxOp(opId)
        .catch((error) => reportError(error, "Couldn't discard"));
    },
    [reportError],
  );

  return {
    state: {
      activeFile,
      currentUser,
      fileContent,
      lastRefreshAt,
      loading,
      prs,
      refreshing,
      selectedPR,
      threads,
    },
    actions: {
      deleteComment,
      discardOp,
      openPR,
      postCommentForRange,
      refreshActivePR,
      refreshPRList,
      replyTo,
      retryOp,
      switchFile,
      toggleResolve,
    },
  };
}
