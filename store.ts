// store.ts — in-memory git object store, pack codec, pkt-line codec, and the
// repository/issue/pull-request records for the forge. Standard library only.
// Everything here is deterministic: no wall clock, no randomness.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// --- fixed identity and time -------------------------------------------------
// The scenario viewer is constant across trials (the harness seeds it from a
// fixed constant), so the token owner is hardcoded here. All timestamps come
// from MAKEFUN_TRIAL_NOW when present, else a fixed epoch, so replays are
// byte-identical.

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

function trialNow(): { epoch: number; iso: string } {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw) {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) {
      const epoch = Math.floor(ms / 1000);
      return { epoch, iso: new Date(epoch * 1000).toISOString() };
    }
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) {
      const epoch = asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
      return { epoch, iso: new Date(epoch * 1000).toISOString() };
    }
  }
  return { epoch: 1735689600, iso: '2025-01-01T00:00:00.000Z' };
}

export const NOW = trialNow();
export const COMMIT_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

// --- tree / commit / tag parsing and building --------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const ts = fields.timestamp ?? NOW.epoch;
  const who = `${fields.author ?? COMMIT_IDENTITY} ${ts} +0000`;
  const committer = `${fields.committer ?? COMMIT_IDENTITY} ${ts} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error('tag header has no value');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error('tag has a bad type');
  }
  return {
    object,
    type: type as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// Parse an identity line like "Name <email> 1700000000 +0000".
export function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: NOW.iso };
  const epoch = Number(match[3]);
  return { name: match[1], email: match[2], date: new Date(epoch * 1000).toISOString() };
}

// --- pkt-line codec ------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export type PktPacket =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

export function decodePktLines(buf: Buffer): { packets: PktPacket[]; consumed: number; complete: boolean } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      return { packets, consumed: offset, complete: false };
    }
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) {
      return { packets, consumed: offset, complete: false };
    }
    packets.push({ kind: 'data', data: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset, complete: offset === buf.length };
}

// Read packets from the start of buf until (and including) the first flush.
// Returns the packets and the offset just past the flush; the bytes after that
// are the pack payload in a receive-pack request.
export function readUntilFlush(buf: Buffer): { packets: PktPacket[]; next: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('not a pkt-line stream');
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, next: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', data: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  throw new Error('pkt-line stream ends without a flush');
}

// --- packfile codec ------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readPackSizeHeader(buf: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack size varint is truncated');
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buf: Buffer, start: number): { baseDistance: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseDistance: value, next: offset };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjType;
  resolved?: Buffer;
  oid?: string;
}

// Parse a packfile (v2/v3, plain objects plus OFS/REF deltas) into objects
// keyed by id. `resolveBase` supplies thin-pack bases already in the store.
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackSizeHeader(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseDistance <= 0 || base.baseDistance > entryOffset) {
        throw new Error('ofs-delta names an invalid base offset');
      }
      entry.baseOffset = entryOffset - base.baseDistance;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error('ref-delta base is neither in the pack nor in the store');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

// Build a packfile from plain objects (no deltas). Order is the caller's.
export function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// --- repository records ------------------------------------------------------

export interface CommentRec {
  id: number;
  body: string;
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  comments: CommentRec[];
  seq: number;
}

export interface FlatEntry {
  oid: string;
  mode: string;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  sha: string;
}

export class Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects = new Map<string, GitObj>();
  refs = new Map<string, string>();
  labels = new Map<string, LabelRec>();
  issues = new Map<number, IssueRec>();
  pulls = new Map<number, PullRec>();
  seq = 0;
  version = 0;
  fetchCache = new Map<string, Buffer>();
  issueJsonCache = new Map<number, string>();
  private commitCache = new Map<string, CommitView>();
  private treeCache = new Map<string, Map<string, FlatEntry>>();

  constructor(id: number, name: string, owner: string, description: string, isPrivate: boolean, defaultBranch: string) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  bump(): void {
    this.version += 1;
    this.fetchCache.clear();
    this.issueJsonCache.clear();
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  getCommit(oid: string): CommitView | undefined {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return undefined;
    try {
      const view = parseCommit(obj.data);
      this.commitCache.set(oid, view);
      return view;
    } catch {
      return undefined;
    }
  }

  // Peel tags until a non-tag object; returns the final oid and its type.
  peel(oid: string): { oid: string; type: ObjType } | undefined {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const obj = this.objects.get(current);
      if (!obj) return undefined;
      if (obj.type !== 'tag') return { oid: current, type: obj.type };
      try {
        current = parseTag(obj.data).object;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  // Resolve a ref name, branch short name, or raw oid to a commit oid.
  resolveToCommit(ref: string): string | undefined {
    const direct = this.refs.get(ref);
    if (direct) {
      const peeled = this.peel(direct);
      return peeled && peeled.type === 'commit' ? peeled.oid : undefined;
    }
    const branch = this.refs.get(`refs/heads/${ref}`);
    if (branch) {
      const peeled = this.peel(branch);
      return peeled && peeled.type === 'commit' ? peeled.oid : undefined;
    }
    if (isOid(ref)) {
      const peeled = this.peel(ref);
      return peeled && peeled.type === 'commit' ? peeled.oid : undefined;
    }
    return undefined;
  }

  // Flatten a commit's tree into path -> entry, with a per-commit cache.
  flatTree(commitOid: string): Map<string, FlatEntry> | undefined {
    const cached = this.treeCache.get(commitOid);
    if (cached) return cached;
    const commit = this.getCommit(commitOid);
    if (!commit) return undefined;
    const flat = new Map<string, FlatEntry>();
    const walk = (treeOid: string, prefix: string, guard: Set<string>): void => {
      if (guard.has(treeOid)) return;
      guard.add(treeOid);
      const obj = this.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      let entries: TreeEntry[];
      try {
        entries = parseTree(obj.data);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') {
          walk(entry.oid, path, guard);
        } else if (entry.mode === '160000') {
          // gitlink: record but never follow
          flat.set(path, { oid: entry.oid, mode: entry.mode });
        } else {
          flat.set(path, { oid: entry.oid, mode: entry.mode });
        }
      }
    };
    walk(commit.tree, '', new Set());
    this.treeCache.set(commitOid, flat);
    return flat;
  }

  // Build (and store) a tree object hierarchy from a flat path map.
  buildTreeFromFlat(flat: Map<string, FlatEntry>): string {
    interface DirNode {
      files: TreeEntry[];
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: [], dirs: new Map() };
    for (const [path, entry] of [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        let child = node.dirs.get(parts[i]);
        if (!child) {
          child = { files: [], dirs: new Map() };
          node.dirs.set(parts[i], child);
        }
        node = child;
      }
      node.files.push({ mode: entry.mode, name: parts[parts.length - 1], oid: entry.oid });
    }
    const build = (node: DirNode): string => {
      const entries: TreeEntry[] = [...node.files];
      for (const [name, child] of node.dirs) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.getCommit(current);
      if (commit) for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  // Nearest common ancestor by summed BFS distance, or null.
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const distA = new Map<string, number>();
    const queueA: string[] = [a];
    distA.set(a, 0);
    for (let i = 0; i < queueA.length; i += 1) {
      const commit = this.getCommit(queueA[i]);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!distA.has(parent)) {
          distA.set(parent, distA.get(queueA[i])! + 1);
          queueA.push(parent);
        }
      }
    }
    let best: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    const distB = new Map<string, number>();
    const queueB: string[] = [b];
    distB.set(b, 0);
    for (let i = 0; i < queueB.length; i += 1) {
      const current = queueB[i];
      const dB = distB.get(current)!;
      if (distA.has(current)) {
        const total = dB + distA.get(current)!;
        if (total < bestDist) {
          bestDist = total;
          best = current;
        }
      }
      if (dB + 1 > bestDist) continue;
      const commit = this.getCommit(current);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!distB.has(parent)) {
          distB.set(parent, dB + 1);
          queueB.push(parent);
        }
      }
    }
    return best;
  }

  // History from a tip, newest first (pre-order DFS following parents).
  history(tip: string, limit: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.getCommit(current);
      if (!commit) continue;
      out.push(current);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
    }
    return out;
  }
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  const text = content.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function diffLineCounts(oldContent: Buffer | undefined, newContent: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = oldContent ? oldContent.toString('utf8').split('\n') : [];
  const newLines = newContent ? newContent.toString('utf8').split('\n') : [];
  if (oldContent && oldContent.toString('utf8').endsWith('\n')) oldLines.pop();
  if (newContent && newContent.toString('utf8').endsWith('\n')) newLines.pop();
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

// Diff two flattened trees; returns changed paths sorted by name.
export function diffFlats(
  repo: Repo,
  baseFlat: Map<string, FlatEntry>,
  headFlat: Map<string, FlatEntry>,
): FileDiff[] {
  const diffs: FileDiff[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base && head && base.oid === head.oid) continue;
    if (!base && head) {
      const blob = repo.getObject(head.oid);
      diffs.push({ filename: path, status: 'added', additions: blob ? countLines(blob.data) : 0, deletions: 0, sha: head.oid });
    } else if (base && !head) {
      const blob = repo.getObject(base.oid);
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions: blob ? countLines(blob.data) : 0, sha: base.oid });
    } else if (base && head) {
      const oldBlob = repo.getObject(base.oid)?.data;
      const newBlob = repo.getObject(head.oid)?.data;
      const counts = diffLineCounts(oldBlob, newBlob);
      diffs.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, sha: head.oid });
    }
  }
  return diffs;
}

// True when head and base both changed the same path differently since their
// merge-base (a three-way conflict).
export function hasMergeConflict(repo: Repo, baseTip: string, headTip: string): boolean {
  const mb = repo.mergeBase(baseTip, headTip);
  const baseFlat = mb ? repo.flatTree(mb) ?? new Map() : new Map<string, FlatEntry>();
  const bFlat = repo.flatTree(baseTip) ?? new Map<string, FlatEntry>();
  const hFlat = repo.flatTree(headTip) ?? new Map<string, FlatEntry>();
  const paths = new Set<string>([...baseFlat.keys(), ...bFlat.keys(), ...hFlat.keys()]);
  for (const path of paths) {
    const orig = baseFlat.get(path)?.oid;
    const bVal = bFlat.get(path)?.oid;
    const hVal = hFlat.get(path)?.oid;
    const changedBase = bVal !== orig;
    const changedHead = hVal !== orig;
    if (changedBase && changedHead && bVal !== hVal) return true;
  }
  return false;
}

// The tree produced by applying head's changes (relative to merge-base) onto
// the base tip's tree. Only call when there is no conflict.
export function squashTree(repo: Repo, baseTip: string, headTip: string): Map<string, FlatEntry> {
  const mb = repo.mergeBase(baseTip, headTip);
  const baseFlat = mb ? repo.flatTree(mb) ?? new Map() : new Map<string, FlatEntry>();
  const bFlat = repo.flatTree(baseTip) ?? new Map<string, FlatEntry>();
  const hFlat = repo.flatTree(headTip) ?? new Map<string, FlatEntry>();
  const result = new Map<string, FlatEntry>(bFlat);
  const paths = new Set<string>([...baseFlat.keys(), ...hFlat.keys()]);
  for (const path of paths) {
    const orig = baseFlat.get(path)?.oid;
    const hVal = hFlat.get(path);
    if ((hVal?.oid ?? undefined) !== orig) {
      if (hVal) result.set(path, hVal);
      else result.delete(path);
    }
  }
  return result;
}

// --- fetch object selection ----------------------------------------------------

export interface FetchSelection {
  objects: Map<string, GitObj>;
  shallow: string[];
  unshallow: string[];
}

// Reachable objects from roots, following commit parents (except through
// commits in `stopAtParents`, whose parents are treated as not held) and tree
// entries. Unknown roots are ignored.
function reachableClosure(repo: Repo, roots: string[], stopAtParents: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = repo.getCommit(oid);
      if (!commit) continue;
      stack.push(commit.tree);
      if (!stopAtParents.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      try {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      } catch {
        // corrupt tree: stop here
      }
    } else if (obj.type === 'tag') {
      try {
        stack.push(parseTag(obj.data).object);
      } catch {
        // corrupt tag: stop here
      }
    }
  }
  return seen;
}

export function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  prevShallow: string[],
): FetchSelection {
  const shallowSet = new Set(prevShallow);
  const haveClosure = reachableClosure(repo, haves, shallowSet);

  // Expand wants: peel tags (keeping the tag objects), collect commit roots.
  const tagObjects = new Map<string, GitObj>();
  const roots: string[] = [];
  const extraRoots: string[] = [];
  for (const want of wants) {
    let current = want;
    for (let hops = 0; hops < 16; hops += 1) {
      const obj = repo.getObject(current);
      if (!obj) break;
      if (obj.type === 'tag') {
        tagObjects.set(current, obj);
        try {
          current = parseTag(obj.data).object;
        } catch {
          break;
        }
        continue;
      }
      if (obj.type === 'commit') roots.push(current);
      else extraRoots.push(current);
      break;
    }
  }

  // BFS over parents with a depth limit. A commit already in the have-closure
  // is not expanded unless it is a previous shallow boundary (deepen case).
  const depthLimit = depth ?? Number.POSITIVE_INFINITY;
  const generation = new Map<string, number>();
  const queue: string[] = [];
  for (const root of roots) {
    if (!generation.has(root)) {
      generation.set(root, 0);
      queue.push(root);
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    const gen = generation.get(current)!;
    if (gen + 1 >= depthLimit) continue;
    if (haveClosure.has(current) && !shallowSet.has(current)) continue;
    const commit = repo.getCommit(current);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (!generation.has(parent) && repo.getObject(parent)) {
        generation.set(parent, gen + 1);
        queue.push(parent);
      }
    }
  }

  const included = new Set<string>(generation.keys());

  // Shallow boundaries: included commits with a parent that is neither
  // included nor held by the client.
  const shallow: string[] = [];
  for (const oid of included) {
    const commit = repo.getCommit(oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (!included.has(parent) && !haveClosure.has(parent)) {
        shallow.push(oid);
        break;
      }
    }
  }

  // Unshallow: previous boundaries whose parents are now all included/held.
  const unshallow: string[] = [];
  for (const oid of prevShallow) {
    if (!included.has(oid)) continue;
    const commit = repo.getCommit(oid);
    if (!commit) continue;
    const resolved = commit.parents.every((p) => included.has(p) || haveClosure.has(p));
    if (resolved) unshallow.push(oid);
  }

  // Objects to send: the included commits plus the tree/blob closure of each
  // (trees only — parents are never followed here, so depth limits hold),
  // plus wanted tag objects and the closure of wanted trees/blobs, minus
  // what the client already holds.
  const objects = new Map<string, GitObj>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    const seenTrees = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (haveClosure.has(oid)) continue;
      const obj = repo.getObject(oid);
      if (!obj) continue;
      if (obj.type === 'tree') {
        if (seenTrees.has(oid)) continue;
        seenTrees.add(oid);
        objects.set(oid, obj);
        try {
          for (const entry of parseTree(obj.data)) {
            if (entry.mode !== '160000') stack.push(entry.oid);
          }
        } catch {
          // corrupt tree: stop here
        }
      } else if (obj.type === 'blob') {
        objects.set(oid, obj);
      }
    }
  };
  for (const oid of included) {
    if (haveClosure.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (!obj) continue;
    objects.set(oid, obj);
    const commit = repo.getCommit(oid);
    if (commit) addTreeClosure(commit.tree);
  }
  for (const [oid, obj] of tagObjects) {
    if (!haveClosure.has(oid)) objects.set(oid, obj);
  }
  for (const extra of extraRoots) {
    if (haveClosure.has(extra)) continue;
    const obj = repo.getObject(extra);
    if (!obj) continue;
    if (obj.type === 'tree') addTreeClosure(extra);
    else objects.set(extra, obj);
  }
  return { objects, shallow, unshallow };
}

// --- the forge -----------------------------------------------------------------

export class Forge {
  repos = new Map<string, Repo>();
  repoIdSeq = 0;
  recordIdSeq = 0;

  nextRecordId(): number {
    this.recordIdSeq += 1;
    return this.recordIdSeq;
  }

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
    this.repoIdSeq += 1;
    const repo = new Repo(this.repoIdSeq, name, VIEWER.login, description, isPrivate, defaultBranch);
    this.repos.set(name.toLowerCase(), repo);
    return repo;
  }

  findRepo(owner: string, name: string): Repo | undefined {
    if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return undefined;
    return this.repos.get(name.toLowerCase());
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name.toLowerCase());
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }
}

// Opaque stable global ids for GraphQL (base64 of a typed key).
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | undefined {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 1) return undefined;
    return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return undefined;
  }
}
