// app.ts — HTTP server: routing, REST v3, GraphQL dispatch, and the MCP
// endpoint, all backed by the same in-memory Forge. No UI, no outside calls.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Forge,
  NOW,
  VIEWER,
  globalId,
  isOid,
  parseTree,
  type FlatEntry,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';
import {
  commentJson,
  commitJson,
  createIssue,
  createPullRequest,
  issueJson,
  labelJson,
  mergePullRequest,
  pullFiles,
  pullIssueJson,
  pullJson,
  repoJson,
  userJson,
} from './domain.ts';
import { commitFlatTree, handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { executeOperation } from './graphql.ts';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

// The trial token is fixed for the process's lifetime; read it once instead
// of hitting process.env on every request.
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function isAuthorized(req: IncomingMessage): boolean {
  if (!EXPECTED_TOKEN) return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${EXPECTED_TOKEN}`;
}

// Minimal query-string reader: scans for one key at a time with the same
// decoding rules as URLSearchParams (percent-decoding, '+' as space), without
// building a URL object per request. Handlers that rebuild the whole query
// (pagination links) use params() for a real URLSearchParams, lazily.
class Query {
  private cache = new Map<string, string | null>();
  private all: URLSearchParams | null = null;
  private qs: string;

  constructor(qs: string) {
    this.qs = qs;
  }

  get(name: string): string | null {
    const hit = this.cache.get(name);
    if (hit !== undefined) return hit;
    let result: string | null = null;
    const qs = this.qs;
    let i = 0;
    for (;;) {
      const amp = qs.indexOf('&', i);
      const pair = amp < 0 ? qs.slice(i) : qs.slice(i, amp);
      const eq = pair.indexOf('=');
      const rawKey = eq < 0 ? pair : pair.slice(0, eq);
      let key = rawKey;
      if (rawKey.includes('%') || rawKey.includes('+')) {
        try {
          key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
        } catch {
          key = rawKey;
        }
      }
      if (key === name) {
        const rawVal = eq < 0 ? '' : pair.slice(eq + 1);
        if (rawVal.includes('%') || rawVal.includes('+')) {
          try {
            result = decodeURIComponent(rawVal.replace(/\+/g, ' '));
          } catch {
            result = rawVal;
          }
        } else {
          result = rawVal;
        }
        break;
      }
      if (amp < 0) break;
      i = amp + 1;
      if (i > qs.length) break;
    }
    this.cache.set(name, result);
    return result;
  }

  params(): URLSearchParams {
    if (!this.all) this.all = new URLSearchParams(this.qs);
    return this.all;
  }
}

const EMPTY_QUERY = new Query('');

function parseRequestTarget(rawUrl: string): { pathname: string; query: Query } {
  // Absolute-form targets (a proxy's) still go through URL parsing.
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    const url = new URL(rawUrl);
    return { pathname: decodePath(url.pathname), query: new Query(url.search.slice(1)) };
  }
  const q = rawUrl.indexOf('?');
  const rawPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
  return { pathname: decodePath(rawPath), query: q < 0 ? EMPTY_QUERY : new Query(rawUrl.slice(q + 1)) };
}

function decodePath(pathname: string): string {
  if (!pathname.includes('%')) return pathname;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendJsonBuffer(res: ServerResponse, status: number, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...extraHeaders });
  res.end();
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function errorJson(message: string): Record<string, unknown> {
  return { message, documentation_url: 'https://example.invalid/docs' };
}

// The suite dials one host for the whole trial; memoize the base URL per host.
const baseUrlCache = new Map<string, string>();

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  let base = baseUrlCache.get(host);
  if (base === undefined) {
    base = `http://${host}/api/v3`;
    if (baseUrlCache.size > 16) baseUrlCache.clear();
    baseUrlCache.set(host, base);
  }
  return base;
}

function pageParams(query: Query): { page: number; perPage: number } {
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const perRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perPage = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(perRaw, 100) : 30;
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), totalPages };
}

function linkHeader(req: IncomingMessage, path: string, query: Query, page: number, perPage: number, totalPages: number): string | null {
  const host = req.headers.host ?? '127.0.0.1';
  const params = query.params();
  const build = (p: number): string => {
    const q = new URLSearchParams(params);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<http://${host}${path}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${build(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${build(page - 1)}; rel="prev"`);
  links.push(`${build(1)}; rel="first"`);
  links.push(`${build(totalPages)}; rel="last"`);
  return links.length > 0 ? links.join(', ') : null;
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  const text = body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

// --- REST: repos, branches, refs, commits, contents ------------------------------

function handleRoot(req: IncomingMessage, res: ServerResponse): void {
  const base = baseUrlOf(req);
  sendJson(
    res,
    200,
    {
      current_user_url: `${base}/user`,
      current_user_authorizations_html_url: '',
      authorizations_url: `${base}/authorizations`,
      code_search_url: `${base}/search/code`,
      commit_search_url: `${base}/search/commits`,
      emails_url: `${base}/user/emails`,
      emojis_url: `${base}/emojis`,
      events_url: `${base}/events`,
      feeds_url: `${base}/feeds`,
      followers_url: `${base}/user/followers`,
      following_url: `${base}/user/following`,
      gists_url: `${base}/gists`,
      hub_url: `${base}/hub`,
      issue_search_url: `${base}/search/issues`,
      issues_url: `${base}/issues`,
      keys_url: `${base}/user/keys`,
      label_search_url: `${base}/search/labels`,
      notifications_url: `${base}/notifications`,
      organization_url: `${base}/orgs/{org}`,
      organization_repositories_url: `${base}/orgs/{org}/repos`,
      organization_teams_url: `${base}/orgs/{org}/teams`,
      public_gists_url: `${base}/gists/public`,
      rate_limit_url: `${base}/rate_limit`,
      repository_url: `${base}/repos/{owner}/{repo}`,
      repository_search_url: `${base}/search/repositories`,
      current_user_repositories_url: `${base}/user/repos`,
      starred_url: `${base}/user/starred`,
      starred_gists_url: `${base}/gists/starred`,
      topic_search_url: `${base}/search/topics`,
      user_url: `${base}/users/{user}`,
      user_organizations_url: `${base}/user/orgs`,
      user_repositories_url: `${base}/users/{user}/repos`,
      user_search_url: `${base}/search/users`,
    },
    { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' },
  );
}

function handleMeta(res: ServerResponse): void {
  sendJson(res, 200, {
    verifiable_password_authentication: true,
    ssh_key_fingerprints: {},
    ssh_keys: [],
    hooks: [],
    web: [],
    api: [],
    git: [],
    packages: [],
    pages: [],
    importer: [],
    actions: [],
    dependabot: [],
    installed_version: '1.0.0',
  });
}

function handleUserReposList(forge: Forge, req: IncomingMessage, res: ServerResponse, pathname: string, query: Query): void {
  const { page, perPage } = pageParams(query);
  const repos = forge.listRepos();
  const { pageItems, totalPages } = paginate(repos, page, perPage);
  const base = baseUrlOf(req);
  const headers: Record<string, string> = {};
  const link = linkHeader(req, pathname, query, page, perPage, totalPages);
  if (link) headers.link = link;
  sendJson(res, 200, pageItems.map((repo) => repoJson(repo, base)), headers);
}

function handleUserReposCreate(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  const name = asString(body.name);
  if (!name) {
    sendJson(res, 422, { ...errorJson('Validation Failed'), errors: [{ resource: 'Repository', field: 'name', code: 'missing' }] });
    return;
  }
  if (forge.findRepo(VIEWER.login, name)) {
    sendJson(res, 422, errorJson('Repository already exists'));
    return;
  }
  const description = asString(body.description);
  const isPrivate = body.private === true;
  const defaultBranch = asString(body.default_branch, 'main') || 'main';
  const repo = forge.createRepo(name, description, isPrivate, defaultBranch);
  sendJson(res, 201, repoJson(repo, baseUrlOf(req)));
}

function handleRepoGet(repo: Repo, req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, repoJson(repo, baseUrlOf(req)));
}

function handleRepoPatch(repo: Repo, req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
  repo.bump();
  sendJson(res, 200, repoJson(repo, baseUrlOf(req)));
}

function handleBranchesList(repo: Repo, req: IncomingMessage, res: ServerResponse): void {
  const base = baseUrlOf(req);
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: oid, url: `${base}/repos/${repo.fullName}/commits/${oid}` },
      protected: false,
    });
  }
  sendJson(res, 200, branches);
}

function handleBranchGet(repo: Repo, req: IncomingMessage, res: ServerResponse, branch: string): void {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const base = baseUrlOf(req);
  sendJson(res, 200, {
    name: branch,
    commit: { sha: oid, url: `${base}/repos/${repo.fullName}/commits/${oid}`, ...((commitJson(repo, oid, base) ?? {}) as Record<string, unknown>) },
    protected: false,
    protection: { enabled: false },
    pattern: branch,
  });
}

function refJson(repo: Repo, ref: string, oid: string, base: string): Record<string, unknown> {
  const obj = repo.getObject(oid);
  return {
    ref,
    node_id: globalId('Ref', `${repo.id}:${ref}`),
    url: `${base}/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha: oid, type: obj?.type ?? 'commit', url: `${base}/repos/${repo.fullName}/git/commits/${oid}` },
  };
}

function handleRefsList(repo: Repo, req: IncomingMessage, res: ServerResponse): void {
  const base = baseUrlOf(req);
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  sendJson(res, 200, refs.map(([ref, oid]) => refJson(repo, ref, oid, base)));
}

function handleRefGet(repo: Repo, req: IncomingMessage, res: ServerResponse, rest: string[]): void {
  const base = baseUrlOf(req);
  const ref = `refs/${rest.join('/')}`;
  const exact = repo.refs.get(ref);
  if (exact) {
    sendJson(res, 200, refJson(repo, ref, exact, base));
    return;
  }
  const matches = [...repo.refs.entries()]
    .filter(([name]) => name.startsWith(`${ref}/`) || name.startsWith(ref))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (matches.length > 0) {
    sendJson(res, 200, matches.map(([name, oid]) => refJson(repo, name, oid, base)));
    return;
  }
  sendJson(res, 404, errorJson('Not Found'));
}

function handleRefCreate(repo: Repo, req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (!ref.startsWith('refs/') || !isOid(sha)) {
    sendJson(res, 422, errorJson('Validation Failed'));
    return;
  }
  if (repo.refs.has(ref)) {
    sendJson(res, 422, errorJson('Reference already exists'));
    return;
  }
  if (!repo.getObject(sha)) {
    sendJson(res, 422, errorJson('Object does not exist'));
    return;
  }
  repo.refs.set(ref, sha);
  repo.bump();
  sendJson(res, 201, refJson(repo, ref, sha, baseUrlOf(req)));
}

function handleRefDelete(repo: Repo, res: ServerResponse, rest: string[]): void {
  const ref = `refs/${rest.join('/')}`;
  if (!repo.refs.has(ref)) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  repo.refs.delete(ref);
  repo.bump();
  sendNoContent(res);
}

function handleCommitsList(repo: Repo, req: IncomingMessage, res: ServerResponse, pathname: string, query: Query): void {
  const { page, perPage } = pageParams(query);
  const shaParam = query.get('sha');
  const tip = shaParam ? repo.resolveToCommit(shaParam) : repo.resolveToCommit(`refs/heads/${repo.defaultBranch}`);
  const base = baseUrlOf(req);
  if (!tip) {
    sendJson(res, 200, []);
    return;
  }
  const all = repo.history(tip, 100000);
  const { pageItems, totalPages } = paginate(all, page, perPage);
  const headers: Record<string, string> = {};
  const link = linkHeader(req, pathname, query, page, perPage, totalPages);
  if (link) headers.link = link;
  const items: Record<string, unknown>[] = [];
  for (const oid of pageItems) {
    const json = commitJson(repo, oid, base);
    if (json) items.push(json);
  }
  sendJson(res, 200, items, headers);
}

function handleCommitGet(repo: Repo, req: IncomingMessage, res: ServerResponse, sha: string): void {
  const resolved = repo.resolveToCommit(sha);
  const json = resolved ? commitJson(repo, resolved, baseUrlOf(req)) : undefined;
  if (!json) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  sendJson(res, 200, json);
}

// --- contents --------------------------------------------------------------------

interface DirEntryOut {
  type: string;
  size: number;
  name: string;
  path: string;
  sha: string;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
}

function contentsEntryJson(
  repo: Repo,
  base: string,
  ref: string,
  type: 'file' | 'dir',
  name: string,
  path: string,
  sha: string,
  size: number,
): DirEntryOut {
  return {
    type,
    size,
    name,
    path,
    sha,
    url: `${base}/repos/${repo.fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    html_url: `https://example.invalid/${repo.fullName}/blob/${encodeURIComponent(ref)}/${path}`,
    git_url: `${base}/repos/${repo.fullName}/git/blobs/${sha}`,
    download_url: type === 'file' ? '' : null,
  };
}

// Tree oid of the directory at `dirPath` ('' = root) in a commit's tree.
function subtreeOid(repo: Repo, commitOid: string, dirPath: string): string | undefined {
  const commit = repo.getCommit(commitOid);
  if (!commit) return undefined;
  let current = commit.tree;
  if (!dirPath) return current;
  for (const segment of dirPath.split('/')) {
    const obj = repo.getObject(current);
    if (!obj || obj.type !== 'tree') return undefined;
    let found: string | undefined;
    try {
      for (const entry of parseTree(obj.data)) {
        if (entry.name === segment && entry.mode === '40000') found = entry.oid;
      }
    } catch {
      return undefined;
    }
    if (!found) return undefined;
    current = found;
  }
  return current;
}

function handleContentsGet(repo: Repo, req: IncomingMessage, res: ServerResponse, query: Query, pathParts: string[]): void {
  const base = baseUrlOf(req);
  const ref = query.get('ref') ?? repo.defaultBranch;
  const tip = repo.resolveToCommit(ref);
  if (!tip) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const path = pathParts.join('/');
  const flat = repo.flatTree(tip) ?? new Map<string, FlatEntry>();
  const file = flat.get(path);
  if (file) {
    const blob = repo.getObject(file.oid);
    const bytes = blob?.data ?? Buffer.alloc(0);
    const name = pathParts[pathParts.length - 1] ?? '';
    sendJson(res, 200, {
      ...contentsEntryJson(repo, base, ref, 'file', name, path, file.oid, bytes.length),
      encoding: 'base64',
      content: bytes.toString('base64'),
    });
    return;
  }
  // Directory? Either the root or a prefix of some path.
  const isDir = path === '' || [...flat.keys()].some((key) => key.startsWith(`${path}/`));
  if (!isDir) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const treeOid = subtreeOid(repo, tip, path);
  if (!treeOid) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const treeObj = repo.getObject(treeOid);
  if (!treeObj || treeObj.type !== 'tree') {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  let entries;
  try {
    entries = parseTree(treeObj.data);
  } catch {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const out: DirEntryOut[] = [];
  for (const entry of entries) {
    const childPath = path ? `${path}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      out.push(contentsEntryJson(repo, base, ref, 'dir', entry.name, childPath, entry.oid, 0));
    } else {
      const blob = repo.getObject(entry.oid);
      out.push(contentsEntryJson(repo, base, ref, 'file', entry.name, childPath, entry.oid, blob?.data.length ?? 0));
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  sendJson(res, 200, out);
}

function handleContentsPut(
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  pathParts: string[],
  body: Record<string, unknown>,
): void {
  const base = baseUrlOf(req);
  const path = pathParts.join('/');
  const branch = asString(body.branch, repo.defaultBranch) || repo.defaultBranch;
  const contentB64 = asString(body.content);
  const bytes = Buffer.from(contentB64, 'base64');
  const message = asString(body.message, `Update ${path}`) || `Update ${path}`;
  const branchRef = `refs/heads/${branch}`;
  let tip = repo.refs.get(branchRef);
  if (!tip) {
    // Fork the new branch from the default branch tip (or start unborn).
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const flat = new Map<string, FlatEntry>(tip ? repo.flatTree(tip) ?? new Map() : new Map());
  const current = flat.get(path);
  const givenSha = asString(body.sha);
  if (current && givenSha && givenSha !== current.oid) {
    sendJson(res, 409, errorJson('The blob sha does not match the current file content'));
    return;
  }
  const isUpdate = !!current;
  const blobOid = repo.putObject('blob', bytes);
  flat.set(path, { oid: blobOid, mode: current?.mode ?? '100644' });
  const parents = tip ? [tip] : [];
  const commitOid = commitFlatTree(repo, branch, flat, message, parents);
  const name = pathParts[pathParts.length - 1] ?? '';
  const commit = commitJson(repo, commitOid, base) ?? {};
  sendJson(res, isUpdate ? 200 : 201, {
    content: {
      ...contentsEntryJson(repo, base, branch, 'file', name, path, blobOid, bytes.length),
      encoding: 'base64',
    },
    commit,
  });
}

function handleContentsDelete(
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  pathParts: string[],
  body: Record<string, unknown>,
): void {
  const base = baseUrlOf(req);
  const path = pathParts.join('/');
  const branch = asString(body.branch, repo.defaultBranch) || repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const flat = new Map<string, FlatEntry>(repo.flatTree(tip) ?? new Map());
  const current = flat.get(path);
  if (!current) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const givenSha = asString(body.sha);
  if (givenSha && givenSha !== current.oid) {
    sendJson(res, 409, errorJson('The blob sha does not match the current file content'));
    return;
  }
  flat.delete(path);
  const message = asString(body.message, `Delete ${path}`) || `Delete ${path}`;
  const commitOid = commitFlatTree(repo, branch, flat, message, [tip]);
  const commit = commitJson(repo, commitOid, base) ?? {};
  sendJson(res, 200, { content: null, commit });
}

// --- REST: labels, issues, pulls -------------------------------------------------

function handleLabelsList(repo: Repo, req: IncomingMessage, res: ServerResponse): void {
  const base = baseUrlOf(req);
  sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(repo, label, base)));
}

function handleLabelCreate(forge: Forge, repo: Repo, req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  const name = asString(body.name);
  if (!name) {
    sendJson(res, 422, errorJson('Validation Failed'));
    return;
  }
  const existing = repo.labels.get(name);
  if (existing) {
    sendJson(res, 201, labelJson(repo, existing, baseUrlOf(req)));
    return;
  }
  const label = {
    id: forge.nextRecordId(),
    name,
    color: asString(body.color, 'ededed') || 'ededed',
    description: asString(body.description),
  };
  repo.labels.set(name, label);
  repo.bump();
  sendJson(res, 201, labelJson(repo, label, baseUrlOf(req)));
}

function handleLabelGet(repo: Repo, req: IncomingMessage, res: ServerResponse, name: string): void {
  const label = repo.labels.get(name);
  if (!label) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  sendJson(res, 200, labelJson(repo, label, baseUrlOf(req)));
}

function labelNamesFromBody(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') {
      names.push((item as Record<string, unknown>).name as string);
    }
  }
  return names;
}

function handleIssuesCreate(forge: Forge, repo: Repo, req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  const title = asString(body.title);
  if (!title) {
    sendJson(res, 422, errorJson('Validation Failed'));
    return;
  }
  const result = createIssue(forge, repo, title, asString(body.body), labelNamesFromBody(body));
  if ('error' in result) {
    sendJson(res, 422, errorJson(result.error));
    return;
  }
  sendJson(res, 201, issueJson(repo, result.issue, baseUrlOf(req)));
}

function handleIssuesList(repo: Repo, req: IncomingMessage, res: ServerResponse, pathname: string, query: Query): void {
  const { page, perPage } = pageParams(query);
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  const base = baseUrlOf(req);
  type Row = { seq: number; json: Record<string, unknown>; state: string };
  const rows: Row[] = [];
  for (const issue of repo.issues.values()) {
    rows.push({ seq: issue.seq, json: issueJson(repo, issue, base), state: issue.state });
  }
  for (const pull of repo.pulls.values()) {
    rows.push({ seq: pull.seq, json: pullIssueJson(repo, pull, base), state: pull.state });
  }
  const filtered = state === 'all' ? rows : rows.filter((row) => row.state === state);
  filtered.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { pageItems, totalPages } = paginate(filtered, page, perPage);
  const headers: Record<string, string> = {};
  const link = linkHeader(req, pathname, query, page, perPage, totalPages);
  if (link) headers.link = link;
  sendJson(res, 200, pageItems.map((row) => row.json), headers);
}

function findIssueOrPull(repo: Repo, n: number): { issue: IssueRec } | { pull: PullRec } | null {
  const issue = repo.issues.get(n);
  if (issue) return { issue };
  const pull = repo.pulls.get(n);
  if (pull) return { pull };
  return null;
}

function handleIssueGet(repo: Repo, req: IncomingMessage, res: ServerResponse, n: number): void {
  const found = findIssueOrPull(repo, n);
  if (!found) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  if ('issue' in found) {
    const cached = repo.issueJsonCache.get(n);
    if (cached) {
      sendJsonBuffer(res, 200, cached);
      return;
    }
    const body = Buffer.from(JSON.stringify(issueJson(repo, found.issue, baseUrlOf(req))), 'utf8');
    repo.issueJsonCache.set(n, body);
    sendJsonBuffer(res, 200, body);
    return;
  }
  sendJson(res, 200, pullIssueJson(repo, found.pull, baseUrlOf(req)));
}

function handleIssuePatch(repo: Repo, req: IncomingMessage, res: ServerResponse, n: number, body: Record<string, unknown>): void {
  const found = findIssueOrPull(repo, n);
  if (!found) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const base = baseUrlOf(req);
  if (Array.isArray(body.labels)) {
    const names = labelNamesFromBody(body);
    for (const name of names) {
      if (!repo.labels.has(name)) {
        sendJson(res, 422, errorJson(`label "${name}" does not exist`));
        return;
      }
    }
    if ('issue' in found) found.issue.labels = names;
  }
  if ('issue' in found) {
    if (typeof body.title === 'string') found.issue.title = body.title;
    if (typeof body.body === 'string') found.issue.body = body.body;
    if (body.state === 'open' || body.state === 'closed') found.issue.state = body.state;
    repo.bump();
    sendJson(res, 200, issueJson(repo, found.issue, base));
    return;
  }
  if (typeof body.title === 'string') found.pull.title = body.title;
  if (typeof body.body === 'string') found.pull.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    if (!found.pull.merged) found.pull.state = body.state;
  }
  repo.bump();
  sendJson(res, 200, pullIssueJson(repo, found.pull, base));
}

function handleCommentsList(repo: Repo, req: IncomingMessage, res: ServerResponse, n: number): void {
  const found = findIssueOrPull(repo, n);
  if (!found) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const base = baseUrlOf(req);
  const comments = 'issue' in found ? found.issue.comments : found.pull.comments;
  sendJson(res, 200, comments.map((comment) => commentJson(repo, comment, n, base)));
}

function handleCommentCreate(forge: Forge, repo: Repo, req: IncomingMessage, res: ServerResponse, n: number, body: Record<string, unknown>): void {
  const found = findIssueOrPull(repo, n);
  if (!found) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const text = asString(body.body);
  if (!text) {
    sendJson(res, 422, errorJson('Validation Failed'));
    return;
  }
  const comment = { id: forge.nextRecordId(), body: text };
  if ('issue' in found) found.issue.comments.push(comment);
  else found.pull.comments.push(comment);
  repo.bump();
  sendJson(res, 201, commentJson(repo, comment, n, baseUrlOf(req)));
}

function handlePullsCreate(forge: Forge, repo: Repo, req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  const title = asString(body.title);
  const head = stripOwnerPrefix(asString(body.head));
  const baseRef = stripOwnerPrefix(asString(body.base));
  if (!title || !head || !baseRef) {
    sendJson(res, 422, errorJson('Validation Failed'));
    return;
  }
  const result = createPullRequest(forge, repo, title, asString(body.body), head, baseRef);
  if ('error' in result) {
    sendJson(res, 422, errorJson(result.error));
    return;
  }
  sendJson(res, 201, pullJson(repo, result.pull, baseUrlOf(req)));
}

function handlePullsList(repo: Repo, req: IncomingMessage, res: ServerResponse, pathname: string, query: Query): void {
  const { page, perPage } = pageParams(query);
  const state = query.get('state') ?? 'open';
  const base = baseUrlOf(req);
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  const { pageItems, totalPages } = paginate(pulls, page, perPage);
  const headers: Record<string, string> = {};
  const link = linkHeader(req, pathname, query, page, perPage, totalPages);
  if (link) headers.link = link;
  sendJson(res, 200, pageItems.map((pull) => pullJson(repo, pull, base)), headers);
}

function handlePullGet(repo: Repo, req: IncomingMessage, res: ServerResponse, n: number): void {
  const pull = repo.pulls.get(n);
  if (!pull) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  sendJson(res, 200, pullJson(repo, pull, baseUrlOf(req)));
}

function handlePullPatch(repo: Repo, req: IncomingMessage, res: ServerResponse, n: number, body: Record<string, unknown>): void {
  const pull = repo.pulls.get(n);
  if (!pull) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  if (typeof body.title === 'string') pull.title = body.title;
  if (typeof body.body === 'string') pull.body = body.body;
  if ((body.state === 'open' || body.state === 'closed') && !pull.merged) pull.state = body.state;
  repo.bump();
  sendJson(res, 200, pullJson(repo, pull, baseUrlOf(req)));
}

function handlePullFiles(repo: Repo, req: IncomingMessage, res: ServerResponse, n: number): void {
  const pull = repo.pulls.get(n);
  if (!pull) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const base = baseUrlOf(req);
  const diffs = pullFiles(repo, pull);
  sendJson(res, 200, diffs.map((diff) => ({
    sha: diff.sha ?? '',
    filename: diff.filename,
    status: diff.status,
    additions: diff.additions,
    deletions: diff.deletions,
    changes: diff.additions + diff.deletions,
    blob_url: '',
    raw_url: '',
    contents_url: `${base}/repos/${repo.fullName}/contents/${diff.filename}`,
    patch: '',
  })));
}

function handlePullMerge(repo: Repo, res: ServerResponse, n: number): void {
  const pull = repo.pulls.get(n);
  if (!pull) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const result = mergePullRequest(repo, pull);
  if (!result.ok) {
    if (result.reason === 'conflict') {
      sendJson(res, 405, errorJson('Merge conflict: the pull request cannot be merged cleanly'));
      return;
    }
    if (result.reason === 'closed') {
      sendJson(res, 405, errorJson('Pull request is already merged or closed'));
      return;
    }
    sendJson(res, 422, errorJson('Pull request head or base branch is missing'));
    return;
  }
  sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
}

// --- MCP -------------------------------------------------------------------------

const MCP_BASE = 'http://forge.invalid/api/v3';

const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpArg(args: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null) return args[key];
  }
  return undefined;
}

function mcpOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = asString(mcpArg(args, 'owner', 'owner_login', 'org'));
  const repo = asString(mcpArg(args, 'repo', 'repo_name', 'repository', 'repository_name'));
  if (owner && repo) return { owner, repo };
  const full = asString(mcpArg(args, 'full_name', 'fullName'));
  const slash = full.indexOf('/');
  if (slash > 0) return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
  if (!owner && repo.includes('/')) {
    const idx = repo.indexOf('/');
    return { owner: repo.slice(0, idx), repo: repo.slice(idx + 1) };
  }
  if (repo && !owner) return { owner: VIEWER.login, repo };
  return null;
}

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: unknown;
  isError?: boolean;
}

function mcpOk(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function mcpFail(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function mcpCallTool(forge: Forge, name: string, args: Record<string, unknown>): McpToolResult | { rpcError: number; message: string } {
  const need = (value: unknown, label: string): string | null => {
    if (typeof value !== 'string' || !value) return label;
    return null;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = asString(mcpArg(args, 'name', 'repo', 'repo_name'));
      const missing = need(repoName, 'name');
      if (missing) return { rpcError: -32602, message: `missing required argument: ${missing}` };
      const existing = forge.findRepo(VIEWER.login, repoName);
      if (existing) return mcpOk(repoJson(existing, MCP_BASE));
      const repo = forge.createRepo(repoName, asString(mcpArg(args, 'description', 'body')), mcpArg(args, 'private') === true, 'main');
      return mcpOk(repoJson(repo, MCP_BASE));
    }
    case 'get_repo': {
      const target = mcpOwnerRepo(args);
      if (!target) return { rpcError: -32602, message: 'missing required arguments: owner, repo' };
      const repo = forge.findRepo(target.owner, target.repo);
      if (!repo) return mcpFail('Repository not found');
      return mcpOk(repoJson(repo, MCP_BASE));
    }
    case 'create_issue': {
      const target = mcpOwnerRepo(args);
      const title = asString(mcpArg(args, 'title'));
      if (!target) return { rpcError: -32602, message: 'missing required arguments: owner, repo' };
      if (!title) return { rpcError: -32602, message: 'missing required argument: title' };
      const repo = forge.findRepo(target.owner, target.repo);
      if (!repo) return mcpFail('Repository not found');
      const result = createIssue(forge, repo, title, asString(mcpArg(args, 'body', 'description')), []);
      if ('error' in result) return mcpFail(result.error);
      return mcpOk(issueJson(repo, result.issue, MCP_BASE));
    }
    case 'list_issues': {
      const target = mcpOwnerRepo(args);
      if (!target) return { rpcError: -32602, message: 'missing required arguments: owner, repo' };
      const repo = forge.findRepo(target.owner, target.repo);
      if (!repo) return mcpFail('Repository not found');
      const state = asString(mcpArg(args, 'state', 'status'), 'open').toLowerCase();
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return mcpOk(issues.map((issue) => issueJson(repo, issue, MCP_BASE)));
    }
    case 'create_pull_request': {
      const target = mcpOwnerRepo(args);
      const title = asString(mcpArg(args, 'title'));
      const head = stripOwnerPrefix(asString(mcpArg(args, 'head', 'head_branch', 'head_ref')));
      const baseRef = stripOwnerPrefix(asString(mcpArg(args, 'base', 'base_branch', 'base_ref')));
      if (!target) return { rpcError: -32602, message: 'missing required arguments: owner, repo' };
      if (!title) return { rpcError: -32602, message: 'missing required argument: title' };
      if (!head) return { rpcError: -32602, message: 'missing required argument: head' };
      if (!baseRef) return { rpcError: -32602, message: 'missing required argument: base' };
      const repo = forge.findRepo(target.owner, target.repo);
      if (!repo) return mcpFail('Repository not found');
      const result = createPullRequest(forge, repo, title, asString(mcpArg(args, 'body', 'description')), head, baseRef);
      if ('error' in result) return mcpFail(result.error);
      return mcpOk(pullJson(repo, result.pull, MCP_BASE));
    }
    case 'merge_pull_request': {
      const target = mcpOwnerRepo(args);
      const rawNumber = mcpArg(args, 'pull_number', 'pullNumber', 'number', 'pr_number');
      if (!target) return { rpcError: -32602, message: 'missing required arguments: owner, repo' };
      if (rawNumber === undefined) return { rpcError: -32602, message: 'missing required argument: pull_number' };
      const number = typeof rawNumber === 'number' ? rawNumber : Number.parseInt(String(rawNumber), 10);
      if (!Number.isFinite(number)) return { rpcError: -32602, message: 'pull_number must be a number' };
      const repo = forge.findRepo(target.owner, target.repo);
      if (!repo) return mcpFail('Repository not found');
      const pull = repo.pulls.get(number);
      if (!pull) return mcpFail('Pull request not found');
      const result = mergePullRequest(repo, pull);
      if (!result.ok) return mcpFail(result.reason === 'conflict' ? 'Merge conflict' : 'Pull request is already closed');
      return mcpOk({ sha: result.sha, merged: true, message: 'Pull request successfully merged', number: pull.number });
    }
    default:
      return { rpcError: -32601, message: `unknown tool: ${name}` };
  }
}

function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!isAuthorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
    return;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const requests = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const responses: Array<Record<string, unknown>> = [];
  let sawNotificationOnly = true;
  for (const item of requests) {
    const record = asRecord(item);
    if (!record || typeof record.method !== 'string') {
      responses.push({ jsonrpc: '2.0', id: record?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
      sawNotificationOnly = false;
      continue;
    }
    const id = record.id;
    const hasId = id !== undefined && id !== null;
    const method = record.method;
    if (method.startsWith('notifications/')) {
      continue;
    }
    sawNotificationOnly = false;
    const params = asRecord(record.params) ?? {};
    if (!hasId) {
      // Other notifications get no response.
      continue;
    }
    if (method === 'server/discover') {
      responses.push({
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
          capabilities: { tools: {} },
          serverInfo: { name: 'forge', version: '1.0.0' },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
        },
      });
      continue;
    }
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      responses.push({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: supported.includes(requested) ? requested : '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'forge', version: '1.0.0' },
        },
      });
      continue;
    }
    if (method === 'ping') {
      responses.push({ jsonrpc: '2.0', id, result: {} });
      continue;
    }
    if (method === 'tools/list') {
      responses.push({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
      continue;
    }
    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = asRecord(params.arguments) ?? {};
      const outcome = mcpCallTool(forge, toolName, toolArgs);
      if ('rpcError' in outcome) {
        responses.push({ jsonrpc: '2.0', id, error: { code: outcome.rpcError, message: outcome.message } });
      } else {
        responses.push({ jsonrpc: '2.0', id, result: outcome });
      }
      continue;
    }
    responses.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
  if (sawNotificationOnly && responses.length === 0) {
    res.writeHead(202);
    res.end();
    return;
  }
  const payload = Array.isArray(parsed.value) ? responses : responses[0] ?? { jsonrpc: '2.0', id: null, result: {} };
  const text = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

// --- GraphQL dispatch ------------------------------------------------------------

function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!isAuthorized(req)) {
    sendJson(res, 401, errorJson('Bad credentials'));
    return;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, errorJson('Problems parsing JSON'));
    return;
  }
  const runOne = (item: unknown): Record<string, unknown> => {
    const record = asRecord(item);
    if (!record || typeof record.query !== 'string') {
      return { data: null, errors: [{ message: 'query must be a string' }] };
    }
    const variables = asRecord(record.variables) ?? {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    return executeOperation(forge, record.query, variables, operationName);
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

// --- REST router -------------------------------------------------------------------

function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, pathname: string, query: Query, body: Buffer): void {
  if (!isAuthorized(req)) {
    sendJson(res, 401, errorJson('Bad credentials'));
    return;
  }
  const method = req.method ?? 'GET';
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let bodyRecord: Record<string, unknown> = {};
  if (needsBody && body.length > 0) {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, errorJson('Problems parsing JSON'));
      return;
    }
    const record = asRecord(parsed.value);
    if (parsed.value !== null && record === null && body.toString('utf8').trim() !== '') {
      sendJson(res, 400, errorJson('Problems parsing JSON'));
      return;
    }
    bodyRecord = record ?? {};
  }

  const restPath = pathname === '/api/v3' ? '/' : pathname.slice('/api/v3'.length);
  const segments = restPath.split('/').filter((s) => s.length > 0);

  // Root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      handleRoot(req, res);
      return;
    }
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') {
      handleMeta(res);
      return;
    }
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, userJson());
      return;
    }
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      handleUserReposList(forge, req, res, pathname, query);
      return;
    }
    if (method === 'POST') {
      handleUserReposCreate(forge, req, res, bodyRecord);
      return;
    }
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }

  // /repos/{owner}/{repo}/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const repoName = segments[2];
    const repo = forge.findRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, errorJson('Not Found'));
      return;
    }
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') {
        handleRepoGet(repo, req, res);
        return;
      }
      if (method === 'PATCH') {
        handleRepoPatch(repo, req, res, bodyRecord);
        return;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo.name);
        sendNoContent(res);
        return;
      }
      sendJson(res, 404, errorJson('Not Found'));
      return;
    }
    const head = rest[0];
    if (head === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        handleBranchesList(repo, req, res);
        return;
      }
      if (rest.length >= 2 && method === 'GET') {
        handleBranchGet(repo, req, res, rest.slice(1).join('/'));
        return;
      }
      sendJson(res, 404, errorJson('Not Found'));
      return;
    }
    if (head === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'GET') {
          handleRefsList(repo, req, res);
          return;
        }
        if (method === 'POST') {
          handleRefCreate(repo, req, res, bodyRecord);
          return;
        }
        sendJson(res, 404, errorJson('Not Found'));
        return;
      }
      if (method === 'GET') {
        handleRefGet(repo, req, res, rest.slice(2));
        return;
      }
      if (method === 'DELETE') {
        handleRefDelete(repo, res, rest.slice(2));
        return;
      }
      sendJson(res, 404, errorJson('Not Found'));
      return;
    }
    if (head === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        handleCommitsList(repo, req, res, pathname, query);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        handleCommitGet(repo, req, res, rest[1]);
        return;
      }
      sendJson(res, 404, errorJson('Not Found'));
      return;
    }
    if (head === 'contents') {
      if (method === 'GET') {
        handleContentsGet(repo, req, res, query, rest.slice(1));
        return;
      }
      if (method === 'PUT') {
        handleContentsPut(repo, req, res, rest.slice(1), bodyRecord);
        return;
      }
      if (method === 'DELETE') {
        handleContentsDelete(repo, req, res, rest.slice(1), bodyRecord);
        return;
      }
      sendJson(res, 404, errorJson('Not Found'));
      return;
    }
    if (head === 'labels') {
      if (rest.length === 1) {
        if (method === 'GET') {
          handleLabelsList(repo, req, res);
          return;
        }
        if (method === 'POST') {
          handleLabelCreate(forge, repo, req, res, bodyRecord);
          return;
        }
        sendJson(res, 404, errorJson('Not Found'));
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        handleLabelGet(repo, req, res, rest[1]);
        return;
      }
      sendJson(res, 404, errorJson('Not Found'));
      return;
    }
    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          handleIssuesList(repo, req, res, pathname, query);
          return;
        }
        if (method === 'POST') {
          handleIssuesCreate(forge, repo, req, res, bodyRecord);
          return;
        }
        sendJson(res, 404, errorJson('Not Found'));
        return;
      }
      const n = Number.parseInt(rest[1], 10);
      if (!Number.isFinite(n)) {
        sendJson(res, 404, errorJson('Not Found'));
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          handleIssueGet(repo, req, res, n);
          return;
        }
        if (method === 'PATCH') {
          handleIssuePatch(repo, req, res, n, bodyRecord);
          return;
        }
        sendJson(res, 404, errorJson('Not Found'));
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          handleCommentsList(repo, req, res, n);
          return;
        }
        if (method === 'POST') {
          handleCommentCreate(forge, repo, req, res, n, bodyRecord);
          return;
        }
        sendJson(res, 404, errorJson('Not Found'));
        return;
      }
      sendJson(res, 404, errorJson('Not Found'));
      return;
    }
    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          handlePullsList(repo, req, res, pathname, query);
          return;
        }
        if (method === 'POST') {
          handlePullsCreate(forge, repo, req, res, bodyRecord);
          return;
        }
        sendJson(res, 404, errorJson('Not Found'));
        return;
      }
      const n = Number.parseInt(rest[1], 10);
      if (!Number.isFinite(n)) {
        sendJson(res, 404, errorJson('Not Found'));
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          handlePullGet(repo, req, res, n);
          return;
        }
        if (method === 'PATCH') {
          handlePullPatch(repo, req, res, n, bodyRecord);
          return;
        }
        sendJson(res, 404, errorJson('Not Found'));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        handlePullFiles(repo, req, res, n);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        handlePullMerge(repo, res, n);
        return;
      }
      sendJson(res, 404, errorJson('Not Found'));
      return;
    }
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }

  sendJson(res, 404, errorJson('Not Found'));
}

// --- git router ----------------------------------------------------------------------

function handleGit(forge: Forge, req: IncomingMessage, res: ServerResponse, pathname: string, query: Query, body: Buffer): void {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 2 || !segments[1].endsWith('.git')) {
    sendJson(res, 404, errorJson('Not Found'));
    return;
  }
  const owner = segments[0];
  const repoName = segments[1].slice(0, -'.git'.length);
  const tail = segments.slice(2);
  const method = req.method ?? 'GET';
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service');
    const gitProtocol = req.headers['git-protocol'] ?? '';
    const result = handleInfoRefs(forge, owner, repoName, service, gitProtocol);
    sendRaw(res, result.status, result.contentType, result.body);
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    const result = handleUploadPack(forge, owner, repoName, body);
    sendRaw(res, result.status, result.contentType, result.body);
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    const result = handleReceivePack(forge, owner, repoName, body);
    sendRaw(res, result.status, result.contentType, result.body);
    return;
  }
  sendJson(res, 404, errorJson('Not Found'));
}

// --- server ----------------------------------------------------------------------------

export function createForgeServer(): { server: Server; forge: Forge } {
  const forge = new Forge();
  const server = createServer((req, res) => {
    try {
      const { pathname, query } = parseRequestTarget(req.url ?? '/');
      if (pathname === '/healthz' && (req.method ?? 'GET') === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!requestHasBody(req)) {
        // Bodyless requests (every GET, and POSTs without framing) run
        // synchronously: no stream wait, no promise, no extra event-loop turn.
        dispatch(forge, req, res, pathname, query, EMPTY_BODY);
        return;
      }
      void (async () => {
        try {
          const body = await readBody(req);
          dispatch(forge, req, res, pathname, query, body);
        } catch (err) {
          failRequest(res, err);
        }
      })();
    } catch (err) {
      failRequest(res, err);
    }
  });
  return { server, forge };
}

const EMPTY_BODY = Buffer.alloc(0);

// A request carries a body only when its framing says so: a positive
// Content-Length or a Transfer-Encoding. Anything else is bodyless by the
// HTTP/1.1 rules, so answering without consuming the stream cannot desync a
// keep-alive connection.
function requestHasBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  if (length !== undefined) {
    // Only an unambiguous zero means "no body by Content-Length"; anything
    // else (positive, unparseable, repeated) reads the stream.
    if (Number(length) !== 0) return true;
  }
  return req.headers['transfer-encoding'] !== undefined;
}

function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse, pathname: string, query: Query, body: Buffer): void {
  if (pathname === '/api/graphql' || pathname === '/api/graphql/') {
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 404, errorJson('Not Found'));
      return;
    }
    handleGraphQL(forge, req, res, body);
    return;
  }
  if (pathname === '/mcp' || pathname === '/mcp/') {
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, errorJson('Method Not Allowed'));
      return;
    }
    handleMcp(forge, req, res, body);
    return;
  }
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    handleRest(forge, req, res, pathname, query, body);
    return;
  }
  handleGit(forge, req, res, pathname, query, body);
}

function failRequest(res: ServerResponse, err: unknown): void {
  if (!res.headersSent) {
    try {
      sendJson(res, 500, errorJson((err as Error).message));
    } catch {
      res.destroy();
    }
  } else {
    res.destroy();
  }
}
