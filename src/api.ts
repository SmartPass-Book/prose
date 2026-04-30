import { invoke } from "@tauri-apps/api/core";
import type { PR, PRSummary, ReviewThread, ThreadsResponse } from "./types";

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
    return res.data.repository.pullRequest.reviewThreads.nodes;
  },

  postComment: (params: {
    repo: string;
    number: number;
    commitId: string;
    path: string;
    line: number;
    startLine?: number;
    body: string;
  }) =>
    invoke<unknown>("post_review_comment", {
      repo: params.repo,
      number: params.number,
      commitId: params.commitId,
      path: params.path,
      line: params.line,
      startLine: params.startLine,
      body: params.body,
    }),

  replyToComment: (repo: string, number: number, inReplyTo: number, body: string) =>
    invoke<unknown>("reply_to_comment", { repo, number, inReplyTo, body }),

  mutatePostComment: (params: {
    repo: string;
    number: number;
    commitId: string;
    path: string;
    line: number;
    startLine?: number;
    body: string;
  }) =>
    invoke<string>("mutate_post_comment", {
      repo: params.repo,
      number: params.number,
      commitId: params.commitId,
      path: params.path,
      line: params.line,
      startLine: params.startLine,
      body: params.body,
    }),

  mutateReply: (params: {
    threadId: string;
    repo: string;
    number: number;
    inReplyTo: number;
    body: string;
  }) =>
    invoke<string>("mutate_reply", {
      threadId: params.threadId,
      repo: params.repo,
      number: params.number,
      inReplyTo: params.inReplyTo,
      body: params.body,
    }),

  deleteComment: (repo: string, commentId: number) =>
    invoke<void>("delete_comment", { repo, commentId }),

  mutateDeleteComment: (repo: string, commentId: number) =>
    invoke<string>("mutate_delete_comment", { repo, commentId }),

  resolveThread: (threadId: string, resolved: boolean) =>
    invoke<unknown>("resolve_thread", { threadId, resolved }),

  mutateResolve: (threadId: string, resolved: boolean) =>
    invoke<string>("mutate_resolve", { threadId, resolved }),

  setActivePR: (repo: string | null, number: number | null) =>
    invoke<void>("set_active_pr", { repo, number }),

  setFocus: (visible: boolean) => invoke<void>("set_focus", { visible }),

  forceRefresh: (repo: string, number: number) =>
    invoke<void>("force_refresh", { repo, number }),

  clearCache: () => invoke<void>("clear_cache"),

  clearPrCache: (repo: string, number: number) =>
    invoke<void>("clear_pr_cache", { repo, number }),
};
