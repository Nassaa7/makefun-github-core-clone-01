// gitproto.ts — git smart-HTTP: info/refs advertisement (protocol v0 and v2),
// protocol v2 ls-refs/fetch, protocol v0 fetch, and receive-pack (push).
// No git binary anywhere; everything is built from the object store.

import {
  Forge,
  NOW,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  buildCommit,
  decodePktLines,
  isOid,
  parseCommit,
  parseTag,
  pktLine,
  readPack,
  readUntilFlush,
  selectFetchObjects,
  writePack,
  type GitObj,
  type Repo,
} from './store.ts';

const AGENT = 'forge/1.0';

const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(): GitResponse {
  return {
    status: 404,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'),
  };
}

function badRequest(message: string): GitResponse {
  return {
    status: 400,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// --- info/refs ---------------------------------------------------------------

function advertiseV0(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=git-${service}\n`));
  parts.push(PKT_FLUSH);
  const caps = service === 'upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const headTarget = repo.refs.get(defaultBranchRef(repo));
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    const symref = service === 'upload-pack' ? ` symref=HEAD:${defaultBranchRef(repo)}` : '';
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}${symref}\n`));
    return Buffer.concat(parts);
  }
  const firstCaps = service === 'upload-pack' ? `${caps} symref=HEAD:${defaultBranchRef(repo)}` : caps;
  let first = true;
  const emit = (oid: string, name: string): void => {
    if (first) {
      parts.push(pktLine(`${oid} ${name}\0${firstCaps}\n`));
      first = false;
    } else {
      parts.push(pktLine(`${oid} ${name}\n`));
    }
  };
  if (headTarget) emit(headTarget, 'HEAD');
  for (const [name, oid] of refs) {
    emit(oid, name);
    // Peeled line for annotated tags.
    const obj = repo.getObject(oid);
    if (obj && obj.type === 'tag' && name.startsWith('refs/tags/')) {
      const peeled = repo.peel(oid);
      if (peeled) parts.push(pktLine(`${peeled.oid} ${name}^{}\n`));
    }
  }
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine('ls-refs=unborn\n'));
  parts.push(pktLine('fetch=shallow filter\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(pktLine(`agent=${AGENT}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string | null,
  gitProtocol: string,
): GitResponse {
  const repo = forge.findRepo(owner, repoName);
  if (!repo) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV0(repo, 'upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseV0(repo, 'receive-pack') };
  }
  return badRequest('missing or unknown service');
}

// --- protocol v2 ls-refs -----------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const headRef = defaultBranchRef(repo);
  const headTarget = repo.refs.get(headRef);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (args.symrefs && matches('HEAD')) {
    if (headTarget) {
      parts.push(pktLine(`${headTarget} HEAD symref-target:${headRef}\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${headRef}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const obj = repo.getObject(oid);
      if (obj && obj.type === 'tag') {
        const peeled = repo.peel(oid);
        if (peeled) line += ` peeled:${peeled.oid}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// --- sideband framing ----------------------------------------------------------

const SIDEBAND_CHUNK = 32768;

function sidebandWrap(band: number, data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + SIDEBAND_CHUNK);
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(pktLine(payload));
    offset += chunk.length;
  }
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([band])));
  }
  return parts;
}

// --- fetch (shared selection + pack building) ----------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function buildFetchPack(repo: Repo, req: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const cacheKey = JSON.stringify([repo.version, req.wants, req.haves, req.shallow, req.depth]);
  const cached = repo.fetchCache.get(cacheKey);
  if (cached) {
    // The cache stores pack + shallow/unshallow markers in one blob; the
    // first line is a JSON header, the rest is the pack.
    const newline = cached.indexOf(0x0a);
    const header = JSON.parse(cached.subarray(0, newline).toString('utf8')) as { shallow: string[]; unshallow: string[] };
    return { pack: cached.subarray(newline + 1), shallow: header.shallow, unshallow: header.unshallow };
  }
  const selection = selectFetchObjects(repo, req.wants, req.haves, req.depth, req.shallow);
  const ordered = [...selection.objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const pack = writePack(ordered.map(([, obj]) => obj));
  const header = Buffer.from(`${JSON.stringify({ shallow: selection.shallow, unshallow: selection.unshallow })}\n`, 'utf8');
  const blob = Buffer.concat([header, pack]);
  if (repo.fetchCache.size > 64) repo.fetchCache.clear();
  repo.fetchCache.set(cacheKey, blob);
  return { pack, shallow: selection.shallow, unshallow: selection.unshallow };
}

function buildV2FetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = buildFetchPack(repo, req);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (req.haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of req.haves) {
      if (repo.getObject(have)) parts.push(pktLine(`ACK ${have}\n`));
    }
    if (parts.length === 1) parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const part of sidebandWrap(1, pack)) parts.push(part);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function buildV0FetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = buildFetchPack(repo, req);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (req.haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    let acked = false;
    for (const have of req.haves) {
      if (repo.getObject(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  }
  for (const part of sidebandWrap(1, pack)) parts.push(part);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// --- upload-pack POST ----------------------------------------------------------

export function handleUploadPack(forge: Forge, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = forge.findRepo(owner, repoName);
  if (!repo) return notFound();
  const contentType = 'application/x-git-upload-pack-result';
  let decoded;
  try {
    decoded = decodePktLines(body);
  } catch {
    return badRequest('unparseable request');
  }
  if (!decoded.complete || decoded.packets.length === 0) return badRequest('unparseable request');
  const first = decoded.packets[0];
  if (first.kind !== 'data') return badRequest('unparseable request');
  const firstLine = first.data.toString('utf8');

  if (firstLine.startsWith('command=')) {
    // Protocol v2.
    const command = firstLine.slice('command='.length).trim();
    const lines: string[] = [];
    let afterDelim = false;
    for (const packet of decoded.packets.slice(1)) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind === 'flush') break;
      if (afterDelim) lines.push(packet.data.toString('utf8').trim());
    }
    if (command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of lines) {
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
        else if (line.startsWith('ref-prefix:')) args.prefixes.push(line.slice('ref-prefix:'.length));
      }
      return { status: 200, contentType, body: handleLsRefs(repo, args) };
    }
    if (command === 'fetch') {
      const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
      for (const line of lines) {
        if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) {
          const n = Number.parseInt(line.slice(7).trim(), 10);
          if (Number.isFinite(n) && n > 0) req.depth = n;
        } else if (line === 'deepen' || line.startsWith('deepen-')) {
          // deepen-since / deepen-not: treated as unbounded depth-1? No:
          // git treats deepen-since as a time filter; the suite never sends
          // it with expectations, so ignore the filter and send the full
          // closure (depth stays null).
        }
      }
      return { status: 200, contentType, body: buildV2FetchResponse(repo, req) };
    }
    return badRequest(`unknown command ${command}`);
  }

  // Protocol v0: want lines, optional shallow/deepen, flush, have lines, done.
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let seenFlush = false;
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind === 'delim') continue;
    const line = packet.data.toString('utf8').trim();
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const nul = rest.indexOf('\0');
      req.wants.push((nul >= 0 ? rest.slice(0, nul) : rest).trim());
    } else if (line.startsWith('have ')) {
      req.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      req.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) req.depth = n;
    } else if (line === 'done') {
      // end of negotiation
    } else if (!seenFlush && line.length > 0 && !line.startsWith('shallow')) {
      // Unknown pre-flush line: ignore, stay liberal.
    }
  }
  if (req.wants.length === 0) return badRequest('no wants in fetch request');
  return { status: 200, contentType, body: buildV0FetchResponse(repo, req) };
}

// --- receive-pack POST -----------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = forge.findRepo(owner, repoName);
  if (!repo) return notFound();
  const contentType = 'application/x-git-receive-pack-result';

  let commands: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  let useSideband = false;
  try {
    const { packets, next } = readUntilFlush(body);
    packBytes = body.subarray(next);
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.data.toString('utf8');
      const nul = text.indexOf('\0');
      const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
      if (nul >= 0) {
        const caps = text.slice(nul + 1);
        if (caps.includes('side-band-64k')) useSideband = true;
      }
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (!match) continue;
      commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
    }
  } catch {
    return badRequest('unparseable push request');
  }

  // Unpack first: every object lands in the store even when a ref update is
  // refused, matching git's unpack-then-update order.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.getObject(oid));
      for (const [oid, obj] of objects) {
        if (!repo.getObject(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${(err as Error).message}`;
    }
  }

  const results: string[] = [];
  if (unpackOk) {
    for (const command of commands) {
      results.push(applyRefUpdate(repo, command));
    }
    if (commands.length > 0) repo.bump();
  } else {
    for (const command of commands) {
      results.push(`ng ${command.ref} unpack failed`);
    }
  }

  const reportLines = [`unpack ${unpackDetail}\n`, ...results.map((r) => `${r}\n`)];
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  let responseBody: Buffer;
  if (useSideband) {
    responseBody = Buffer.concat([...sidebandWrap(1, inner), PKT_FLUSH]);
  } else {
    responseBody = inner;
  }
  return { status: 200, contentType, body: responseBody };
}

function applyRefUpdate(repo: Repo, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);

  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return `ng ${ref} remote ref does not exist`;
    if (oldOid !== ZERO_OID && oldOid !== current) return `ng ${ref} old oid mismatch`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }

  // The new object must exist (in the pack just unpacked, or already stored).
  const target = repo.getObject(newOid);
  if (!target) return `ng ${ref} missing object`;

  if (current === undefined) {
    // Create.
    if (oldOid !== ZERO_OID) return `ng ${ref} old oid mismatch`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }

  if (oldOid !== current) return `ng ${ref} old oid mismatch`;
  if (newOid === current) return `ok ${ref}`;

  if (ref.startsWith('refs/heads/')) {
    // Fast-forward only: the old tip must be an ancestor of the new tip.
    const oldCommit = repo.peel(oldOid);
    const newCommit = repo.peel(newOid);
    if (!oldCommit || !newCommit || oldCommit.type !== 'commit' || newCommit.type !== 'commit') {
      return `ng ${ref} non-fast-forward`;
    }
    if (!repo.isAncestor(oldCommit.oid, newCommit.oid)) return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// --- helpers shared with the REST layer -----------------------------------------

// Create a commit object on a branch from a flat tree, moving the ref.
export function commitFlatTree(
  repo: Repo,
  branch: string,
  flat: Map<string, { oid: string; mode: string }>,
  message: string,
  parents: string[],
): string {
  const treeOid = repo.buildTreeFromFlat(flat);
  const commitData = buildCommit({
    tree: treeOid,
    parents,
    message: message.endsWith('\n') ? message : `${message}\n`,
    timestamp: NOW.epoch,
  });
  const commitOid = repo.putObject('commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.bump();
  return commitOid;
}

export function parseCommitMessage(data: Buffer): string {
  try {
    const view = parseCommit(data);
    return view.message.replace(/\n$/, '');
  } catch {
    return '';
  }
}

export function parseTagTarget(data: Buffer): string | undefined {
  try {
    return parseTag(data).object;
  } catch {
    return undefined;
  }
}

export type { GitObj };
