import { invoke } from "@tauri-apps/api/core";
import type { PR, PRSummary, ReviewThread, ThreadsResponse } from "../types";

export const api = {
  getCurrentUser: () => invoke<string>("get_current_user"),

  listPRs: (repo: string) =>
    invoke<PRSummary[]>("list_prs", { repo }),

  refreshPRs: (repo: string) =>
    invoke<PRSummary[]>("refresh_prs", { repo }),

  getPR: (repo: string, number: number) =>
    invoke<PR>("get_pr", { repo, number }),

  getPRFetchedAt: (repo: string, number: number) =>
    invoke<string | null>("get_pr_fetched_at", { repo, number }),

  refreshPR: (repo: string, number: number) =>
    invoke<PR>("refresh_pr", { repo, number }),

  getFile: (repo: string, ref: string, path: string) =>
    invoke<string>("get_file_content", { repo, gitRef: ref, path }),

  getThreads: async (repo: string, number: number): Promise<ReviewThread[]> => {
    const res = await invoke<ThreadsResponse>("get_review_threads", { repo, number });
    // Older cached payloads may predate clientKey; fall back to the server
    // id (identical unless the thread went through a tmp promotion).
    return res.data.repository.pullRequest.reviewThreads.nodes.map((t) => ({
      ...t,
      clientKey: t.clientKey ?? t.id,
    }));
  },

  mutatePostComment: (params: {
    repo: string;
    number: number;
    commitId: string;
    path: string;
    line: number;
    startLine?: number;
    body: string;
    clientKey: string;
  }) =>
    invoke<string>("mutate_post_comment", {
      repo: params.repo,
      number: params.number,
      commitId: params.commitId,
      path: params.path,
      line: params.line,
      startLine: params.startLine,
      body: params.body,
      clientKey: params.clientKey,
    }),

  mutateReply: (params: {
    threadId: string; // the thread's clientKey
    repo: string;
    number: number;
    inReplyTo: number;
    body: string;
    clientKey: string; // the new reply comment's identity
  }) =>
    invoke<string>("mutate_reply", {
      threadId: params.threadId,
      repo: params.repo,
      number: params.number,
      inReplyTo: params.inReplyTo,
      body: params.body,
      clientKey: params.clientKey,
    }),

  mutateDeleteComment: (repo: string, commentId: number) =>
    invoke<string>("mutate_delete_comment", { repo, commentId }),

  mutateResolve: (threadId: string, resolved: boolean) =>
    invoke<string>("mutate_resolve", { threadId, resolved }),

  setActivePR: (repo: string | null, number: number | null) =>
    invoke<void>("set_active_pr", { repo, number }),

  setFocus: (visible: boolean) => invoke<void>("set_focus", { visible }),

  clearPrCache: (repo: string, number: number) =>
    invoke<void>("clear_pr_cache", { repo, number }),

  retryOutboxOp: (opId: string) => invoke<void>("retry_outbox_op", { opId }),

  discardOutboxOp: (opId: string) => invoke<void>("discard_outbox_op", { opId }),
};
