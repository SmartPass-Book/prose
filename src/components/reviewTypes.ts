import type { PRFile, ReviewComment, ReviewThread } from "../types";

export interface LineRange {
  start: number;
  end: number;
}

export interface FileWithThreads extends PRFile {
  unresolved: number;
}

export interface CollaboratorActivity {
  thread: ReviewThread;
  comment: ReviewComment;
}
