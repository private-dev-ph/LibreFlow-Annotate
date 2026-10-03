import { encode, decode, seal, open, createKeys, unlockKeys, sha256, canonical } from './crypto.mjs';
import { RecoveryCache } from './recovery.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set(['project', 'image', 'model', 'annotation', 'review', 'batch', 'dataset', 'version', 'audit', 'session', 'integration']);
export class WorkspaceError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
export function validateManifest(m) { if (!m || m.format !== 'libreflow-workspace' || m.schemaVersion !== 1 || !UUID.test(m.id) || !m.key || typeof m.createdAt !== 'string') throw new WorkspaceError('invalid_manifest', 'Malformed or unsupported workspace manifest'); return m; }
async function bytes(result) { if (result instanceof Uint8Array) return result; if (result instanceof ArrayBuffer) return new Uint8Array(result); if (result?.arrayBuffer) return new Uint8Array(await result.arrayBuffer()); throw new Error('Provider returned invalid data'); }
export class Workspace {
  constructor(provider, root, manifest, key, cache) { this.provider = provider; this.root = root; this.manifest = manifest; this.key = key; this.cache = cache || new RecoveryCache(manifest.id); this.nodes = new Map(); this.status = { state: 'saved', pending: 0, lastSync: null }; this.offline = false; }
  static async create(provider, root, passphrase) {
    if ((await provider.list(root)).some(f => f.name === 'libreflow-workspace.json')) throw new WorkspaceError('conflict', 'This folder already contains a workspace');
    const id = crypto.randomUUID(); const { key, descriptor } = await createKeys(passphrase, id);
    const manifest = { format: 'libreflow-workspace', schemaVersion: 1, id, createdAt: new Date().toISOString(), key: descriptor };
    await provider.write({ parentId: root, name: 'libreflow-workspace.json', bytes: encode(manifest) });
    return new Workspace(provider, root, manifest, key);
  }
  static async connect(provider, root, passphrase) {
    const files = await provider.list(root); const candidates = files.filter(f => f.name === 'libreflow-workspace.json');
    if (candidates.length !== 1) throw new WorkspaceError('invalid_manifest', 'Select a folder containing exactly one LibreFlow workspace');
    const manifest = validateManifest(JSON.parse(decode(await bytes(await provider.read(candidates[0].id)))));
    const workspace = new Workspace(provider, root, manifest, await unlockKeys(passphrase, manifest.key, manifest.id)); await workspace.sync(); return workspace;
  }
  context(id) { return `${this.manifest.id}:${id}`; }
  async unpack(record) {
    if (!record || !UUID.test(record.id) || !record.encrypted) throw new WorkspaceError('corrupt_record', 'Malformed encrypted record');
    const node = JSON.parse(decode(await open(this.key, record.encrypted, this.context(record.id))));
    if (node.id !== record.id || node.schemaVersion !== 1 || !TYPES.has(node.type) || !UUID.test(node.entityId) || !Array.isArray(node.parents) || !node.parents.every(p => UUID.test(p))) throw new WorkspaceError('corrupt_record', 'Invalid workspace record');
    const { hash, ...rest } = node; if (hash !== await sha256(encode(canonical(rest)))) throw new WorkspaceError('checksum', 'Workspace integrity check failed'); return node;
  }
  heads(type, entityId) {
    const all = [...this.nodes.values()].filter(n => n.type === type && n.entityId === entityId);
    const parents = new Set(all.flatMap(n => n.parents)); return all.filter(n => !parents.has(n.id));
  }
  get(type, entityId) { const heads = this.heads(type, entityId); if (heads.length > 1) throw new WorkspaceError('conflict', 'Concurrent changes preserved; choose a revision to resolve', heads); return heads[0]?.value ?? null; }
  list(type) { const ids = new Set([...this.nodes.values()].filter(n => n.type === type).map(n => n.entityId)); return [...ids].map(id => ({ id, value: this.get(type, id) })).filter(item => item.value !== null); }
  async sync() {
    if (this.offline) { this.status.state = 'offline'; return; }
    this.status.state = 'syncing';
    try {
      const files = await this.provider.list(this.root);
      for (const f of files.filter(f => /^record-[0-9a-f-]{36}\.json$/i.test(f.name))) {
        const id = f.name.slice(7, -5); if (this.nodes.has(id)) continue;
        const raw = await bytes(await this.provider.read(f.id)); if (raw.length > 8 * 1024 * 1024) throw new WorkspaceError('size', 'Workspace record exceeds size limit');
        const record = JSON.parse(decode(raw)); if (record.id !== id) throw new WorkspaceError('corrupt_record', 'Record identity mismatch'); this.nodes.set(id, await this.unpack(record));
      }
      const pending = await this.cache.entries();
      for (const record of pending) {
        const node = await this.unpack(record); this.nodes.set(node.id, node);
        if (!files.some(f => f.name === `record-${record.id}.json`)) await this.provider.write({ parentId: this.root, name: `record-${record.id}.json`, bytes: encode(record) });
        await this.cache.delete(record.id);
      }
      this.status.pending = 0; this.status.lastSync = new Date().toISOString();
      const fork = [...this.nodes.values()].some(n => this.heads(n.type, n.entityId).length > 1);
      this.status.state = fork ? 'conflict' : 'saved';
    } catch (e) { this.status.state = e.code === 'conflict' ? 'conflict' : 'pending'; this.status.pending = (await this.cache.entries()).length; throw e; }
  }
  async recover() { for (const record of await this.cache.entries()) { const node = await this.unpack(record); this.nodes.set(node.id, node); } this.status.pending = (await this.cache.entries()).length; this.status.state = this.status.pending ? 'pending' : 'saved'; }
  async put(type, entityId, value, { expectedHeads, resolve = false } = {}) {
    if (!TYPES.has(type) || !UUID.test(entityId)) throw new WorkspaceError('invalid_record', 'Invalid entity identity/type');
    const heads = this.heads(type, entityId);
    if (heads.length > 1 && !resolve) throw new WorkspaceError('conflict', 'Resolve concurrent revisions before saving', heads);
    const parents = heads.map(h => h.id).sort();
    if (expectedHeads && canonical([...expectedHeads].sort()) !== canonical(parents)) throw new WorkspaceError('conflict', 'The entity changed since it was opened', heads);
    if (type === 'version' && heads.length) throw new WorkspaceError('immutable', 'Dataset versions are immutable');
    const node = { schemaVersion: 1, id: crypto.randomUUID(), type, entityId, parents, createdAt: new Date().toISOString(), value: structuredClone(value) };
    node.hash = await sha256(encode(canonical(node)));
    const record = { id: node.id, encrypted: await seal(this.key, encode(node), this.context(node.id)) };
    if (encode(record).length > 8 * 1024 * 1024) throw new WorkspaceError('size', 'Partition large records before saving');
    await this.cache.put(node.id, record); this.nodes.set(node.id, node); this.status.pending++; this.status.state = this.offline ? 'offline' : 'pending';
    if (!this.offline) await this.sync(); return node;
  }
  history(type, entityId) { return [...this.nodes.values()].filter(n => n.type === type && n.entityId === entityId).map(n => structuredClone(n)); }
  async restore(type, entityId, revisionId) { const node = this.nodes.get(revisionId); if (!node || node.type !== type || node.entityId !== entityId) throw new Error('Revision not found'); return this.put(type, entityId, node.value); }
  async manageAsset(file, { signal, onProgress = () => {} } = {}) {
    const chunks = []; const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      signal?.throwIfAborted(); const plain = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer()); const hash = await sha256(plain);
      const name = `asset-${hash}.json`; const existing = (await this.provider.list(this.root)).find(f => f.name === name);
      let ref = existing;
      if (!ref) ref = await this.provider.write({ parentId: this.root, name, bytes: encode(await seal(this.key, plain, `${this.manifest.id}:asset:${hash}`)), signal });
      chunks.push({ id: ref.id, hash, size: plain.length }); onProgress(Math.min(offset + plain.length, file.size), file.size);
    }
    return { mode: 'managed', provider: this.provider.name, chunks, integrity: 'sha256-chunk-list-v1', contentHash: await sha256(encode(canonical(chunks.map(c => ({ hash: c.hash, size: c.size }))))), size: file.size, mimeType: file.type, originalName: file.name };
  }
  async *readAsset(asset, { signal } = {}) {
    if (asset.mode === 'linked') { if (asset.provider !== this.provider.name) throw new WorkspaceError('provider', 'Reconnect the original asset provider'); const stat = await this.provider.stat(asset.id); if (asset.revision && stat.revision !== asset.revision) throw new WorkspaceError('conflict', 'Linked asset changed'); const data = await bytes(await this.provider.read(asset.id, { signal })); if (asset.contentHash && await sha256(data) !== asset.contentHash) throw new WorkspaceError('checksum', 'Linked asset changed'); yield data; return; }
    if (asset.integrity !== 'sha256-chunk-list-v1' || !Array.isArray(asset.chunks) || asset.contentHash !== await sha256(encode(canonical(asset.chunks.map(c => ({ hash: c.hash, size: c.size })))))) throw new WorkspaceError('checksum', 'Invalid asset manifest');
    const files = await this.provider.list(this.root);
    for (const c of asset.chunks) { signal?.throwIfAborted(); const ref = files.find(f => f.name === `asset-${c.hash}.json`); if (!ref) throw new WorkspaceError('not_found', 'Managed asset chunk is missing'); const data = await open(this.key, JSON.parse(decode(await bytes(await this.provider.read(ref.id, { signal })))), `${this.manifest.id}:asset:${c.hash}`); if (data.length !== c.size || await sha256(data) !== c.hash) throw new WorkspaceError('checksum', 'Asset integrity check failed'); yield data; }
  }
  async exportPortable() {
    const files = await this.provider.list(this.root); const records = [];
    for (const f of files.filter(f => /^record-|^asset-/.test(f.name))) records.push({ name: f.name, bytes: Array.from(await bytes(await this.provider.read(f.id))) });
    return { format: 'libreflow-portable', schemaVersion: 1, manifest: this.manifest, records };
  }
  async disconnect() { this.key = null; this.nodes.clear(); this.cache.close(); await this.provider.disconnect(); }
}
export async function importPortable(provider, root, portable, passphrase) {
  if (!portable || portable.format !== 'libreflow-portable' || portable.schemaVersion !== 1 || !Array.isArray(portable.records) || portable.records.length > 100000) throw new WorkspaceError('invalid_manifest', 'Unsupported portable workspace');
  const manifest = validateManifest(portable.manifest); const key = await unlockKeys(passphrase, manifest.key, manifest.id);
  const workspace = new Workspace(provider, root, manifest, key); const names = new Set(); const idMap = new Map(); const decoded = [];
  for (const entry of portable.records) {
    if (!/^record-[0-9a-f-]{36}\.json$|^asset-[0-9a-f]{64}\.json$/i.test(entry.name) || names.has(entry.name) || !Array.isArray(entry.bytes) || entry.bytes.length > 8 * 1024 * 1024) throw new WorkspaceError('invalid_manifest', 'Malformed portable record');
    names.add(entry.name); const data = JSON.parse(decode(Uint8Array.from(entry.bytes)));
    if (entry.name.startsWith('record-')) decoded.push(await workspace.unpack(data));
    else { const hash = entry.name.slice(6, -5); const plain = await open(key, data, `${manifest.id}:asset:${hash}`); if (await sha256(plain) !== hash) throw new WorkspaceError('checksum', 'Corrupt portable asset'); }
  }
  if ((await provider.list(root)).length) throw new WorkspaceError('conflict', 'Import requires an empty destination folder');
  await provider.write({ parentId: root, name: 'libreflow-workspace.json', bytes: encode(manifest) });
  for (const entry of portable.records) { const ref = await provider.write({ parentId: root, name: entry.name, bytes: Uint8Array.from(entry.bytes) }); if (entry.name.startsWith('asset-')) idMap.set(entry.name.slice(6,-5),ref.id); }
  // Preserve immutable records, but map source-provider opaque asset IDs through a separate encrypted migration record.
  for (const node of decoded) workspace.nodes.set(node.id,node);
  workspace.assetMigration = idMap;
  return workspace;
}
