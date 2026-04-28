import { invoke } from "@tauri-apps/api/core";
import type { PR, PRSummary, ReviewThread, ThreadsResponse } from "./types";

export const api = {
  getCurrentUser: () => invoke<string>("get_current_user"),

  listPRs: (repo: string) =>
    invoke<PRSummary[]>("list_prs", { repo }),

  getPR: (repo: string, number: number) =>
    invoke<PR>("get_pr", { repo, number }),

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

  resolveThread: (threadId: string, resolved: boolean) =>
    invoke<unknown>("resolve_thread", { threadId, resolved }),
};
