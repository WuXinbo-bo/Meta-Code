export type GitFileStatus = {
  path: string;
  originalPath?: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "ignored";
  staged: boolean;
  unstaged: boolean;
  additions: number | null;
  deletions: number | null;
};

export type GitBranch = {
  name: string;
  fullName: string;
  remote: boolean;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  subject: string;
  sha: string;
};

export type GitCommit = {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  authoredAt: string;
  subject: string;
  refs: string[];
};

export type GitRemote = {
  name: string;
  fetchUrl: string;
  pushUrl?: string;
};

export type GitSnapshot = {
  isRepository: boolean;
  root: string;
  branch: string;
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  conflicted: boolean;
  files: GitFileStatus[];
  refreshedAt: string;
};
