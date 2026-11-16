// domain.ts — shared domain operations (issues, pull requests, merges) and
// REST JSON serializers, used by the REST, GraphQL, and MCP surfaces so all
// three always agree about the same store.

import {
  Forge,
  NOW,
  VIEWER,
  diffFlats,
  globalId,
  hasMergeConflict,
  parseIdentity,
  squashTree,
  type FileDiff,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type Repo,
} from './store.ts';
import { commitFlatTree } from './gitproto.ts';

// --- issue / pull request operations -------------------------------------------

export function createIssue(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  labelNames: string[],
): { issue: IssueRec } | { error: string } {
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return { error: `label "${name}" does not exist` };
  }
  repo.seq += 1;
  const issue: IssueRec = {
    id: forge.nextRecordId(),
    number: repo.seq,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    comments: [],
    seq: repo.seq,
  };
  repo.issues.set(issue.number, issue);
  repo.bump();
  return { issue };
}

export function createPullRequest(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): { pull: PullRec } | { error: string } {
  const headTip = repo.resolveToCommit(`refs/heads/${head}`) ?? repo.resolveToCommit(head);
  const baseTip = repo.resolveToCommit(`refs/heads/${base}`) ?? repo.resolveToCommit(base);
  if (!headTip) return { error: `head branch "${head}" does not exist` };
  if (!baseTip) return { error: `base branch "${base}" does not exist` };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return { error: 'a pull request for this head and base already exists' };
    }
  }
  repo.seq += 1;
  const pull: PullRec = {
    id: forge.nextRecordId(),
    number: repo.seq,
    title,
    body,
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    mergeCommitSha: null,
    mergedAt: null,
    comments: [],
    seq: repo.seq,
  };
  repo.pulls.set(pull.number, pull);
  repo.bump();
  return { pull };
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'closed' | 'missing' };

export function mergePullRequest(repo: Repo, pull: PullRec): MergeResult {
  if (pull.merged || pull.state === 'closed') return { ok: false, reason: 'closed' };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headCommit = repo.resolveToCommit(headTip);
  const baseCommit = repo.resolveToCommit(baseTip);
  if (!headCommit || !baseCommit) return { ok: false, reason: 'missing' };
  if (hasMergeConflict(repo, baseCommit, headCommit)) return { ok: false, reason: 'conflict' };
  const tree = squashTree(repo, baseCommit, headCommit);
  const message = `${pull.title} (#${pull.number})`;
  const sha = commitFlatTree(repo, pull.baseRef, tree, message, [baseCommit]);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = NOW.iso;
  pull.baseSha = sha;
  repo.bump();
  return { ok: true, sha };
}

export function pullFiles(repo: Repo, pull: PullRec): FileDiff[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headCommit = repo.resolveToCommit(headTip);
  if (!headCommit) return [];
  const baseCommit = repo.resolveToCommit(baseTip);
  const mb = baseCommit ? repo.mergeBase(baseCommit, headCommit) : null;
  const baseFlat = mb ? repo.flatTree(mb) ?? new Map() : new Map();
  const headFlat = repo.flatTree(headCommit) ?? new Map();
  return diffFlats(repo, baseFlat, headFlat);
}

export function pullMergeable(repo: Repo, pull: PullRec): boolean {
  if (pull.merged || pull.state === 'closed') return false;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headCommit = repo.resolveToCommit(headTip);
  const baseCommit = repo.resolveToCommit(baseTip);
  if (!headCommit || !baseCommit) return false;
  return !hasMergeConflict(repo, baseCommit, headCommit);
}

// --- serializers -----------------------------------------------------------------

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', String(VIEWER.id)),
    avatar_url: '',
    gravatar_id: '',
    url: '',
    html_url: '',
    followers_url: '',
    following_url: '',
    gists_url: '',
    starred_url: '',
    subscriptions_url: '',
    organizations_url: '',
    repos_url: '',
    events_url: '',
    received_events_url: '',
    type: 'User',
    user_view_type: 'public',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  let openCount = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openCount += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openCount += 1;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: `https://example.invalid/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/repos/${repo.fullName}`,
    archive_url: '',
    assignees_url: '',
    blobs_url: '',
    branches_url: '',
    collaborators_url: '',
    comments_url: '',
    commits_url: '',
    compare_url: '',
    contents_url: '',
    contributors_url: '',
    deployments_url: '',
    downloads_url: '',
    events_url: '',
    forks_url: '',
    git_commits_url: '',
    git_refs_url: '',
    git_tags_url: '',
    git_url: '',
    issue_comment_url: '',
    issue_events_url: '',
    issues_url: '',
    keys_url: '',
    labels_url: '',
    languages_url: '',
    merges_url: '',
    milestones_url: '',
    notifications_url: '',
    pulls_url: '',
    releases_url: '',
    ssh_url: '',
    stargazers_url: '',
    statuses_url: '',
    subscribers_url: '',
    subscription_url: '',
    tags_url: '',
    teams_url: '',
    trees_url: '',
    clone_url: '',
    mirror_url: '',
    hooks_url: '',
    svn_url: '',
    homepage: '',
    language: null,
    forks_count: 0,
    forks: 0,
    stargazers_count: 0,
    watchers_count: 0,
    watchers: 0,
    size: 0,
    default_branch: repo.defaultBranch,
    open_issues_count: openCount,
    open_issues: openCount,
    is_template: false,
    topics: [],
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    pushed_at: NOW.iso,
    created_at: NOW.iso,
    updated_at: NOW.iso,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_rebase_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_update_branch: false,
    delete_branch_on_merge: false,
    allow_forking: true,
    web_commit_signoff_required: false,
    license: null,
    allow_auto_merge: false,
  };
}

export function labelJson(repo: Repo, label: LabelRec, baseUrl: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', `${repo.id}:${label.id}`),
    url: `${baseUrl}/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    description: label.description,
    color: label.color,
    default: false,
  };
}

function labelListJson(repo: Repo, names: string[], baseUrl: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of names) {
    const label = repo.labels.get(name);
    if (label) out.push(labelJson(repo, label, baseUrl));
  }
  return out;
}

export function issueJson(repo: Repo, issue: IssueRec, baseUrl: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    url: `${baseUrl}/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${baseUrl}/repos/${repo.fullName}`,
    labels_url: `${baseUrl}/repos/${repo.fullName}/issues/${issue.number}/labels`,
    comments_url: `${baseUrl}/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `${baseUrl}/repos/${repo.fullName}/issues/${issue.number}/events`,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    state_reason: null,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: labelListJson(repo, issue.labels, baseUrl),
    assignee: null,
    locked: false,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: NOW.iso,
    updated_at: NOW.iso,
    closed_at: issue.state === 'closed' ? NOW.iso : null,
    author_association: 'OWNER',
    active_lock_reason: null,
    draft: false,
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
  };
}

export function pullIssueJson(repo: Repo, pull: PullRec, baseUrl: string): Record<string, unknown> {
  const base = issueJson(repo, {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    comments: pull.comments,
    seq: pull.seq,
  }, baseUrl);
  base.pull_request = {
    url: `${baseUrl}/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    diff_url: '',
    patch_url: '',
    merged_at: pull.mergedAt,
  };
  return base;
}

function branchRefJson(repo: Repo, ref: string, sha: string, baseUrl: string): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo, baseUrl),
  };
}

export function pullJson(repo: Repo, pull: PullRec, baseUrl: string): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeable = pullMergeable(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    url: `${baseUrl}/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    diff_url: '',
    patch_url: '',
    issue_url: `${baseUrl}/repos/${repo.fullName}/issues/${pull.number}`,
    commits_url: '',
    review_comments_url: '',
    review_comment_url: '',
    comments_url: '',
    statuses_url: '',
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: NOW.iso,
    updated_at: NOW.iso,
    closed_at: pull.state === 'closed' ? NOW.iso : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: branchRefJson(repo, pull.headRef, headSha, baseUrl),
    base: branchRefJson(repo, pull.baseRef, baseSha, baseUrl),
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
    merged: pull.merged,
    mergeable,
    rebaseable: mergeable,
    mergeable_state: pull.merged ? 'unknown' : mergeable ? 'clean' : 'dirty',
    merged_by: pull.merged ? userJson() : null,
    comments: pull.comments.length,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

export function commentJson(
  repo: Repo,
  comment: { id: number; body: string },
  issueNumber: number,
  baseUrl: string,
): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${comment.id}`),
    url: `${baseUrl}/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: NOW.iso,
    updated_at: NOW.iso,
    issue_url: `${baseUrl}/repos/${repo.fullName}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

export function commitJson(repo: Repo, oid: string, baseUrl: string): Record<string, unknown> | undefined {
  const commit = repo.getCommit(oid);
  if (!commit) return undefined;
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  const message = commit.message.replace(/\n$/, '');
  return {
    sha: oid,
    node_id: globalId('Commit', `${repo.id}:${oid}`),
    url: `${baseUrl}/repos/${repo.fullName}/commits/${oid}`,
    html_url: `https://example.invalid/${repo.fullName}/commit/${oid}`,
    comments_url: `${baseUrl}/repos/${repo.fullName}/commits/${oid}/comments`,
    commit: {
      url: `${baseUrl}/repos/${repo.fullName}/git/commits/${oid}`,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message,
      tree: { sha: commit.tree, url: `${baseUrl}/repos/${repo.fullName}/git/trees/${commit.tree}` },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((sha) => ({
      sha,
      url: `${baseUrl}/repos/${repo.fullName}/commits/${sha}`,
      html_url: `https://example.invalid/${repo.fullName}/commit/${sha}`,
    })),
  };
}
