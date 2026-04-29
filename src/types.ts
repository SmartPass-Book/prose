export interface PRSummary {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  author: { login: string };
  isDraft: boolean;
}

export interface PRFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PR {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  state: string;
  url: string;
  author: { login: string };
  updatedAt: string;
  files: PRFile[];
}

export interface ReviewComment {
  id: string;
  databaseId: number;
  body: string;
  author: { login: string };
  createdAt: string;
  url: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  diffSide: string;
  pendingOp?: string | null;
  comments: { nodes: ReviewComment[] };
}

export interface ThreadsResponse {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: ReviewThread[] };
      };
    };
  };
}
