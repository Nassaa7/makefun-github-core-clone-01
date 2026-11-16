// graphql.ts — a small GraphQL parser and executor covering the schema surface
// the conformance suite exercises: viewer/repository/node/__type, issues and
// pull requests with cursor pagination, and the five mutations. It validates
// field names against per-type tables so unknown fields surface as errors.

import {
  Forge,
  NOW,
  VIEWER,
  globalId,
  parseGlobalId,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';
import {
  createIssue,
  createPullRequest,
  mergePullRequest,
  pullFiles,
  pullMergeable,
} from './domain.ts';

// --- tokenizer -----------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: src.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < src.length) {
        const ch = src[j];
        if (ch === '"') break;
        if (ch === '\\') {
          const esc = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += map[esc] ?? esc;
            j += 2;
          }
          continue;
        }
        value += ch;
        j += 1;
      }
      if (j >= src.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// --- AST -------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected "${value}", got ${tok.value}`);
  }

  private expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`expected a name, got ${tok.value}`);
    if (value !== undefined && tok.value !== value) throw new Error(`expected "${value}", got ${tok.value}`);
    return tok.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({
          kind: 'query',
          name: null,
          varDefs: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind, name, varDefs, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${tok.value} at document level`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind !== 'punct' || this.peek().value !== '(') return defs;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.skipDirectives();
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '...') {
      this.next();
      const nextTok = this.peek();
      if (nextTok.kind === 'name' && nextTok.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (nextTok.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind !== 'punct' || this.peek().value !== '(') return args;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      if (isConst) throw new Error('variables are not allowed in constant values');
      return { kind: 'variable', name: this.expectName() };
    }
    if (tok.kind === 'int') return { kind: 'int', value: tok.value };
    if (tok.kind === 'float') return { kind: 'float', value: tok.value };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue(isConst));
      }
      this.next();
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.value}`);
  }
}

// --- value coercion --------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentNode>;
}

function coerceValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name] ?? null;
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
    case 'enum':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => coerceValue(v, ctx));
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const field of node.fields) obj[field.name] = coerceValue(field.value, ctx);
      return obj;
    }
  }
}

function coerceArgs(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = coerceValue(arg.value, ctx);
  return args;
}

// --- wrappers --------------------------------------------------------------------

type AnyObj = Record<string, unknown> & { __typename: string };

function repoObj(repo: Repo): AnyObj {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: Repo, issue: IssueRec): AnyObj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: PullRec): AnyObj {
  return { __typename: 'PullRequest', repo, pull };
}

function userObj(): AnyObj {
  return { __typename: 'User' };
}

function findRepoById(forge: Forge, id: number): Repo | undefined {
  for (const repo of forge.listRepos()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

function findRepoByGlobalId(forge: Forge, gid: string): Repo | undefined {
  const parsed = parseGlobalId(gid);
  if (!parsed || parsed.kind !== 'Repository') return undefined;
  return findRepoById(forge, Number.parseInt(parsed.key, 10));
}

function findIssueByGlobalId(forge: Forge, gid: string): { repo: Repo; issue: IssueRec } | undefined {
  const parsed = parseGlobalId(gid);
  if (!parsed || parsed.kind !== 'Issue') return undefined;
  const [repoId, number] = parsed.key.split(':').map(Number);
  const repo = findRepoById(forge, repoId);
  if (!repo) return undefined;
  const issue = repo.issues.get(number);
  return issue ? { repo, issue } : undefined;
}

function findPullByGlobalId(forge: Forge, gid: string): { repo: Repo; pull: PullRec } | undefined {
  const parsed = parseGlobalId(gid);
  if (!parsed || parsed.kind !== 'PullRequest') return undefined;
  const [repoId, number] = parsed.key.split(':').map(Number);
  const repo = findRepoById(forge, repoId);
  if (!repo) return undefined;
  const pull = repo.pulls.get(number);
  return pull ? { repo, pull } : undefined;
}

// --- pagination --------------------------------------------------------------------

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface PageInfoData {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function pageInfoObj(info: PageInfoData): AnyObj {
  return { __typename: 'PageInfo', ...info };
}

function paginate<T extends { seq: number }>(
  items: T[],
  args: Record<string, unknown>,
  defaultDesc: boolean,
): { page: T[]; pageInfo: PageInfoData; totalCount: number } {
  let ordered = [...items];
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction ?? (defaultDesc ? 'DESC' : 'ASC');
  ordered.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const afterNum = decodeCursor(args.after);
  let start = 0;
  if (afterNum !== null) {
    const idx = ordered.findIndex((item) => item.seq === afterNum);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const first = typeof args.first === 'number' ? args.first : ordered.length;
  const page = ordered.slice(start, start + Math.max(0, first));
  const endIndex = start + page.length;
  return {
    page,
    totalCount: ordered.length,
    pageInfo: {
      hasNextPage: endIndex < ordered.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(page[0].seq) : null,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].seq) : null,
    },
  };
}

// --- introspection tables ------------------------------------------------------------

const TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'search', 'rateLimit'], enumValues: [] },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url',
      'createdAt', 'updatedAt', 'isPrivate', 'fork', 'stargazerCount', 'watchers', 'primaryLanguage',
      'licenseInfo', 'defaultBranch', 'homepageUrl', 'visibility', 'isArchived', 'isDisabled',
    ],
    enumValues: [],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'state', 'body', 'author', 'url', 'createdAt', 'updatedAt', 'closedAt',
      'labels', 'comments', 'repository', 'viewerDidAuthor', 'locked', 'milestone', 'assignees',
      'participants', 'timelineItems', 'stateReason', 'isPinned',
    ],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
      'files', 'headRef', 'baseRef', 'author', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt',
      'repository', 'labels', 'comments', 'reviews', 'reviewRequests', 'isDraft', 'mergeCommit',
      'mergeStateStatus', 'commits', 'additions', 'deletions', 'changedFiles',
    ],
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'bio', 'company', 'location', 'createdAt', 'repositories', 'followers', 'following', 'isViewer', 'websiteUrl'],
    enumValues: [],
  },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'], enumValues: [] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'], enumValues: [] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'url', 'createdAt', 'updatedAt'], enumValues: [] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
};

// --- field tables ----------------------------------------------------------------------

interface FieldDef {
  type: string;
  list?: boolean;
  resolve: (obj: AnyObj, args: Record<string, unknown>, ctx: ExecContext) => unknown;
}

type Table = Record<string, Record<string, FieldDef>>;

const prop = (key: string, type: string): FieldDef => ({
  type,
  resolve: (obj) => obj[key] ?? null,
});

const TABLES: Table = {
  Query: {
    viewer: { type: 'User', resolve: () => userObj() },
    repository: {
      type: 'Repository',
      resolve: (_obj, args, ctx) => {
        const repo = ctx.forge.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoObj(repo) : null;
      },
    },
    node: {
      type: 'Node',
      resolve: (_obj, args, ctx) => {
        const gid = String(args.id ?? '');
        const parsed = parseGlobalId(gid);
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = findRepoById(ctx.forge, Number.parseInt(parsed.key, 10));
          return repo ? repoObj(repo) : null;
        }
        if (parsed.kind === 'Issue') {
          const found = findIssueByGlobalId(ctx.forge, gid);
          return found ? issueObj(found.repo, found.issue) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const found = findPullByGlobalId(ctx.forge, gid);
          return found ? pullObj(found.repo, found.pull) : null;
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_obj, args) => {
        const info = TYPE_INFO[String(args.name ?? '')];
        if (!info) return null;
        return { __typename: '__Type', name: String(args.name), kind: info.kind, fields: info.fields, enumValues: info.enumValues };
      },
    },
    __schema: {
      type: '__Schema',
      resolve: () => ({ __typename: '__Schema' }),
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_obj, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(ctx.forge, String(input.repositoryId ?? ''));
        if (!repo) {
          ctx.errors.push({ message: 'repository not found' });
          return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
        }
        const result = createIssue(ctx.forge, repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in result) {
          ctx.errors.push({ message: result.error });
          return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
        }
        return { __typename: 'CreateIssuePayload', issue: issueObj(repo, result.issue), clientMutationId: input.clientMutationId ?? null };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_obj, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(ctx.forge, String(input.issueId ?? ''));
        if (!found) {
          ctx.errors.push({ message: 'issue not found' });
          return { __typename: 'CloseIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
        }
        found.issue.state = 'closed';
        found.repo.bump();
        return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_obj, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(ctx.forge, String(input.repositoryId ?? ''));
        if (!repo) {
          ctx.errors.push({ message: 'repository not found' });
          return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
        }
        const result = createPullRequest(
          ctx.forge,
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if ('error' in result) {
          ctx.errors.push({ message: result.error });
          return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
        }
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, result.pull), clientMutationId: input.clientMutationId ?? null };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_obj, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGlobalId(ctx.forge, String(input.pullRequestId ?? ''));
        if (!found) {
          ctx.errors.push({ message: 'pull request not found' });
          return { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
        }
        const result = mergePullRequest(found.repo, found.pull);
        if (!result.ok) {
          ctx.errors.push({ message: result.reason === 'conflict' ? 'merge conflict' : 'pull request is already closed' });
          return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_obj, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const gid = String(input.subjectId ?? '');
        const body = String(input.body ?? '');
        const comment = { id: ctx.forge.nextRecordId(), body };
        const asIssue = findIssueByGlobalId(ctx.forge, gid);
        if (asIssue) {
          asIssue.issue.comments.push(comment);
          asIssue.repo.bump();
        } else {
          const asPull = findPullByGlobalId(ctx.forge, gid);
          if (!asPull) {
            ctx.errors.push({ message: 'subject not found' });
            return { __typename: 'AddCommentPayload', commentEdge: null, clientMutationId: input.clientMutationId ?? null };
          }
          asPull.pull.comments.push(comment);
          asPull.repo.bump();
        }
        const node: AnyObj = { __typename: 'IssueComment', id: globalId('IssueComment', `${comment.id}`), body };
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node, cursor: null },
          clientMutationId: input.clientMutationId ?? null,
        };
      },
    },
  },
  Repository: {
    id: { type: 'ID', resolve: (obj) => globalId('Repository', String((obj.repo as Repo).id)) },
    databaseId: { type: 'Int', resolve: (obj) => (obj.repo as Repo).id },
    name: { type: 'String', resolve: (obj) => (obj.repo as Repo).name },
    nameWithOwner: { type: 'String', resolve: (obj) => (obj.repo as Repo).fullName },
    description: { type: 'String', resolve: (obj) => (obj.repo as Repo).description },
    url: { type: 'String', resolve: (obj) => `https://example.invalid/${(obj.repo as Repo).fullName}` },
    isPrivate: { type: 'Boolean', resolve: (obj) => (obj.repo as Repo).isPrivate },
    createdAt: { type: 'String', resolve: () => NOW.iso },
    updatedAt: { type: 'String', resolve: () => NOW.iso },
    owner: { type: 'User', resolve: () => userObj() },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (obj) => ({ __typename: 'Ref', name: (obj.repo as Repo).defaultBranch }),
    },
    viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    issue: {
      type: 'Issue',
      resolve: (obj, args) => {
        const repo = obj.repo as Repo;
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueObj(repo, issue) : null;
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (obj, args) => {
        const repo = obj.repo as Repo;
        let items = [...repo.issues.values()];
        const states = args.states as string[] | undefined;
        if (states && states.length > 0) {
          const wanted = new Set(states.map((s) => s.toLowerCase()));
          items = items.filter((issue) => wanted.has(issue.state));
        }
        const { page, pageInfo, totalCount } = paginate(items, args, false);
        return {
          __typename: 'IssueConnection',
          nodes: page.map((issue) => issueObj(repo, issue)),
          pageInfo: pageInfoObj(pageInfo),
          totalCount,
        };
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (obj, args) => {
        const repo = obj.repo as Repo;
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullObj(repo, pull) : null;
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (obj, args) => {
        const repo = obj.repo as Repo;
        let items = [...repo.pulls.values()];
        const states = args.states as string[] | undefined;
        if (states && states.length > 0) {
          const wanted = new Set(states);
          items = items.filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
            return wanted.has(state);
          });
        } else {
          items = items.filter((pull) => pull.state === 'open');
        }
        const { page, pageInfo, totalCount } = paginate(items, args, true);
        return {
          __typename: 'PullRequestConnection',
          nodes: page.map((pull) => pullObj(repo, pull)),
          pageInfo: pageInfoObj(pageInfo),
          totalCount,
        };
      },
    },
  },
  User: {
    id: { type: 'ID', resolve: () => globalId('User', String(VIEWER.id)) },
    login: { type: 'String', resolve: () => VIEWER.login },
    name: { type: 'String', resolve: () => VIEWER.name },
    email: { type: 'String', resolve: () => VIEWER.email },
    url: { type: 'String', resolve: () => `https://example.invalid/${VIEWER.login}` },
    avatarUrl: { type: 'String', resolve: () => '' },
  },
  Ref: {
    id: { type: 'ID', resolve: (obj) => globalId('Ref', String(obj.name)) },
    name: prop('name', 'String'),
    prefix: { type: 'String', resolve: () => 'refs/heads/' },
  },
  Issue: {
    id: { type: 'ID', resolve: (obj) => globalId('Issue', `${(obj.repo as Repo).id}:${(obj.issue as IssueRec).number}`) },
    number: { type: 'Int', resolve: (obj) => (obj.issue as IssueRec).number },
    title: { type: 'String', resolve: (obj) => (obj.issue as IssueRec).title },
    body: { type: 'String', resolve: (obj) => (obj.issue as IssueRec).body },
    state: { type: 'String', resolve: (obj) => ((obj.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED') },
    url: { type: 'String', resolve: (obj) => `https://example.invalid/${(obj.repo as Repo).fullName}/issues/${(obj.issue as IssueRec).number}` },
    createdAt: { type: 'String', resolve: () => NOW.iso },
    updatedAt: { type: 'String', resolve: () => NOW.iso },
    closedAt: { type: 'String', resolve: (obj) => ((obj.issue as IssueRec).state === 'closed' ? NOW.iso : null) },
    author: { type: 'User', resolve: () => userObj() },
    repository: { type: 'Repository', resolve: (obj) => repoObj(obj.repo as Repo) },
  },
  IssueConnection: {
    nodes: { type: 'Issue', list: true, resolve: (obj) => obj.nodes ?? [] },
    pageInfo: { type: 'PageInfo', resolve: (obj) => obj.pageInfo },
    totalCount: { type: 'Int', resolve: (obj) => obj.totalCount ?? 0 },
    edges: {
      type: 'IssueEdge',
      list: true,
      resolve: (obj) => {
        const nodes = (obj.nodes ?? []) as AnyObj[];
        return nodes.map((node) => ({
          __typename: 'IssueEdge',
          node,
          cursor: encodeCursor((node.issue as IssueRec).seq),
        }));
      },
    },
  },
  IssueEdge: {
    node: { type: 'Issue', resolve: (obj) => obj.node },
    cursor: prop('cursor', 'String'),
  },
  PageInfo: {
    hasNextPage: prop('hasNextPage', 'Boolean'),
    hasPreviousPage: prop('hasPreviousPage', 'Boolean'),
    startCursor: prop('startCursor', 'String'),
    endCursor: prop('endCursor', 'String'),
  },
  PullRequest: {
    id: { type: 'ID', resolve: (obj) => globalId('PullRequest', `${(obj.repo as Repo).id}:${(obj.pull as PullRec).number}`) },
    number: { type: 'Int', resolve: (obj) => (obj.pull as PullRec).number },
    title: { type: 'String', resolve: (obj) => (obj.pull as PullRec).title },
    body: { type: 'String', resolve: (obj) => (obj.pull as PullRec).body },
    state: {
      type: 'String',
      resolve: (obj) => {
        const pull = obj.pull as PullRec;
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      },
    },
    merged: { type: 'Boolean', resolve: (obj) => (obj.pull as PullRec).merged },
    mergeable: {
      type: 'String',
      resolve: (obj) => {
        const repo = obj.repo as Repo;
        const pull = obj.pull as PullRec;
        if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
        return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      },
    },
    headRefName: { type: 'String', resolve: (obj) => (obj.pull as PullRec).headRef },
    baseRefName: { type: 'String', resolve: (obj) => (obj.pull as PullRec).baseRef },
    url: { type: 'String', resolve: (obj) => `https://example.invalid/${(obj.repo as Repo).fullName}/pull/${(obj.pull as PullRec).number}` },
    createdAt: { type: 'String', resolve: () => NOW.iso },
    updatedAt: { type: 'String', resolve: () => NOW.iso },
    mergedAt: { type: 'String', resolve: (obj) => (obj.pull as PullRec).mergedAt },
    author: { type: 'User', resolve: () => userObj() },
    repository: { type: 'Repository', resolve: (obj) => repoObj(obj.repo as Repo) },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (obj, args) => {
        const repo = obj.repo as Repo;
        const pull = obj.pull as PullRec;
        const diffs = pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : diffs.length;
        const page = diffs.slice(0, Math.max(0, first));
        const nodes = page.map((diff) => ({
          __typename: 'PullRequestChangedFile',
          path: diff.filename,
          additions: diff.additions,
          deletions: diff.deletions,
          changeType: diff.status === 'added' ? 'ADDED' : diff.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        }));
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes,
          pageInfo: pageInfoObj({
            hasNextPage: page.length < diffs.length,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null,
          }),
          totalCount: diffs.length,
        };
      },
    },
  },
  PullRequestConnection: {
    nodes: { type: 'PullRequest', list: true, resolve: (obj) => obj.nodes ?? [] },
    pageInfo: { type: 'PageInfo', resolve: (obj) => obj.pageInfo },
    totalCount: { type: 'Int', resolve: (obj) => obj.totalCount ?? 0 },
    edges: {
      type: 'PullRequestEdge',
      list: true,
      resolve: (obj) => {
        const nodes = (obj.nodes ?? []) as AnyObj[];
        return nodes.map((node) => ({
          __typename: 'PullRequestEdge',
          node,
          cursor: encodeCursor((node.pull as PullRec).seq),
        }));
      },
    },
  },
  PullRequestEdge: {
    node: { type: 'PullRequest', resolve: (obj) => obj.node },
    cursor: prop('cursor', 'String'),
  },
  PullRequestChangedFileConnection: {
    nodes: { type: 'PullRequestChangedFile', list: true, resolve: (obj) => obj.nodes ?? [] },
    pageInfo: { type: 'PageInfo', resolve: (obj) => obj.pageInfo },
    totalCount: { type: 'Int', resolve: (obj) => obj.totalCount ?? 0 },
  },
  PullRequestChangedFile: {
    path: prop('path', 'String'),
    additions: prop('additions', 'Int'),
    deletions: prop('deletions', 'Int'),
    changeType: prop('changeType', 'String'),
  },
  __Type: {
    name: prop('name', 'String'),
    kind: prop('kind', 'String'),
    description: { type: 'String', resolve: () => null },
    fields: {
      type: '__Field',
      list: true,
      resolve: (obj) => ((obj.fields ?? []) as string[]).map((name) => ({ __typename: '__Field', name, description: null })),
    },
    enumValues: {
      type: '__EnumValue',
      list: true,
      resolve: (obj) => ((obj.enumValues ?? []) as string[]).map((name) => ({ __typename: '__EnumValue', name, description: null })),
    },
  },
  __Field: {
    name: prop('name', 'String'),
    description: prop('description', 'String'),
  },
  __EnumValue: {
    name: prop('name', 'String'),
    description: prop('description', 'String'),
  },
  __Schema: {
    queryType: { type: '__Type', resolve: () => ({ __typename: '__Type', name: 'Query', kind: 'OBJECT', fields: TYPE_INFO.Query.fields, enumValues: [] }) },
    mutationType: { type: '__Type', resolve: () => ({ __typename: '__Type', name: 'Mutation', kind: 'OBJECT', fields: TYPE_INFO.Mutation.fields, enumValues: [] }) },
    subscriptionType: { type: '__Type', resolve: () => null },
    types: { type: '__Type', list: true, resolve: () => [] },
    directives: { type: '__Directive', list: true, resolve: () => [] },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (obj) => obj.issue ?? null },
    clientMutationId: prop('clientMutationId', 'String'),
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (obj) => obj.issue ?? null },
    clientMutationId: prop('clientMutationId', 'String'),
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (obj) => obj.pullRequest ?? null },
    clientMutationId: prop('clientMutationId', 'String'),
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (obj) => obj.pullRequest ?? null },
    clientMutationId: prop('clientMutationId', 'String'),
  },
  AddCommentPayload: {
    commentEdge: { type: 'IssueCommentEdge', resolve: (obj) => obj.commentEdge ?? null },
    clientMutationId: prop('clientMutationId', 'String'),
  },
  IssueCommentEdge: {
    node: { type: 'IssueComment', resolve: (obj) => obj.node },
    cursor: prop('cursor', 'String'),
  },
  IssueComment: {
    id: prop('id', 'ID'),
    body: prop('body', 'String'),
    author: { type: 'User', resolve: () => userObj() },
    url: { type: 'String', resolve: () => '' },
    createdAt: { type: 'String', resolve: () => NOW.iso },
    updatedAt: { type: 'String', resolve: () => NOW.iso },
  },
  Node: {
    id: {
      type: 'ID',
      resolve: (obj) => {
        if (obj.__typename === 'Repository') return globalId('Repository', String((obj.repo as Repo).id));
        if (obj.__typename === 'Issue') return globalId('Issue', `${(obj.repo as Repo).id}:${(obj.issue as IssueRec).number}`);
        if (obj.__typename === 'PullRequest') return globalId('PullRequest', `${(obj.repo as Repo).id}:${(obj.pull as PullRec).number}`);
        if (obj.__typename === 'User') return globalId('User', String(VIEWER.id));
        return null;
      },
    },
  },
};

// --- executor ------------------------------------------------------------------

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User']);

function typeMatches(condition: string, actual: string): boolean {
  if (condition === actual) return true;
  if (condition === 'Node' && NODE_TYPES.has(actual)) return true;
  return false;
}

function executeSelectionSet(
  typeName: string,
  obj: AnyObj,
  selections: SelectionNode[],
  ctx: ExecContext,
  out: Record<string, unknown>,
): void {
  const table = TABLES[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `unknown fragment "${selection.name}"` });
        continue;
      }
      const actual = obj.__typename ?? typeName;
      if (typeMatches(fragment.typeCondition, actual)) {
        executeSelectionSet(fragment.typeCondition, obj, fragment.selectionSet, ctx, out);
      }
      continue;
    }
    if (selection.kind === 'inline') {
      const actual = obj.__typename ?? typeName;
      if (selection.typeCondition === null || typeMatches(selection.typeCondition, actual)) {
        executeSelectionSet(selection.typeCondition ?? typeName, obj, selection.selectionSet, ctx, out);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = obj.__typename ?? typeName;
      continue;
    }
    const def = table[selection.name] ?? (typeName === 'Node' ? TABLES[obj.__typename ?? '']?.[selection.name] : undefined);
    if (!def) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      continue;
    }
    const args = coerceArgs(selection, ctx);
    let value: unknown;
    try {
      value = def.resolve(obj, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: (err as Error).message });
      out[key] = null;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (!selection.selectionSet) {
      out[key] = value;
      continue;
    }
    const itemType = (value as AnyObj).__typename ?? def.type;
    if (def.list && Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item === null || item === undefined) return null;
        const child: Record<string, unknown> = {};
        executeSelectionSet((item as AnyObj).__typename ?? def.type, item as AnyObj, selection.selectionSet!, ctx, child);
        return child;
      });
    } else if (typeof value === 'object') {
      const child: Record<string, unknown> = {};
      executeSelectionSet(itemType, value as AnyObj, selection.selectionSet, ctx, child);
      out[key] = child;
    } else {
      out[key] = value;
    }
  }
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeOperation(
  forge: Forge,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): GraphQLResult {
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  let operation = document.operations[0];
  if (operationName) {
    operation = document.operations.find((op) => op.name === operationName) ?? operation;
  }
  if (!operation) return { data: null, errors: [{ message: 'no operation found' }] };
  const ctx: ExecContext = { forge, variables: { ...variables }, errors: [], fragments: document.fragments };
  for (const varDef of operation.varDefs) {
    if (ctx.variables[varDef.name] === undefined && varDef.defaultValue) {
      ctx.variables[varDef.name] = coerceValue(varDef.defaultValue, ctx);
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  executeSelectionSet(rootType, { __typename: rootType }, operation.selectionSet, ctx, data);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}
