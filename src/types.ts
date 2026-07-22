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
  // Inclusive [start, end] line ranges that are part of the PR diff, derived
  // from the patch hunks. Only these lines accept a line-anchored review
  // comment; everything else has to be posted at file level. Absent on PR
  // details cached before this field existed.
  commentable?: [number, number][];
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
  // Outbox op tag for optimistic rows. `<op-id>` while the write is in
  // flight, `failed:<op-id>` once it has permanently failed, null for
  // canonical server rows.
  pendingOp?: string | null;
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
