import { ProviderError, asBytes, contentRange, record } from './shared.mjs';

const makeId = () => globalThis.crypto?.randomUUID?.() || `f-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
const aborted = signal => { if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError'); };

export function createFileSystemProvider({ directoryHandle = null, picker = globalThis.showDirectoryPicker } = {}) {
  let root = directoryHandle;
  let workspaceId = 'root';
  const handles = new Map();
  const parents = new Map();
  const ids = new WeakMap();
  const idsFor = handle => { if (!ids.has(handle)) ids.set(handle, makeId()); return ids.get(handle); };
  const permission = async (handle, write = false) => {
    if (!handle) throw new ProviderError('not_found', 'Select a local workspace first.');
    const descriptor = { mode: write ? 'readwrite' : 'read' };
    let status = await handle.queryPermission?.(descriptor);
    if (status !== 'granted') status = await handle.requestPermission?.(descriptor);
    if (status && status !== 'granted') throw new ProviderError('auth_expired', 'The browser has not granted access to this local folder.');
  };
  const getHandle = async id => {
    if (!id || id === 'root' || id === workspaceId) return root;
    if (handles.has(id)) return handles.get(id);
    throw new ProviderError('not_found', 'Local file ID is no longer available.');
  };
  const metadata = async (id, handle) => {
    if (handle.kind === 'directory') return record({ id, name: handle.name, revision: null, size: 0, mimeType: 'inode/directory', providerName: 'local' });
    const file = await handle.getFile();
    return record({ id, name: handle.name, revision: `${file.lastModified}:${file.size}`, size: file.size, mimeType: file.type || 'application/octet-stream', providerName: 'local' });
  };
  return {
    provider: { name: 'local' },
    async connect() {
      if (!root) {
        if (typeof picker !== 'function') throw new ProviderError('provider_error', 'File System Access API is unavailable; use the file-input memory provider.');
        try { root = await picker({ mode: 'readwrite' }); }
        catch (cause) { if (cause?.name === 'AbortError') throw cause; throw new ProviderError('auth_expired', 'Could not open the selected local folder.', { cause }); }
      }
      workspaceId = 'root'; await permission(root, true); return this.capabilities();
    },
    async disconnect() { root = null; workspaceId = 'root'; handles.clear(); parents.clear(); },
    capabilities() { return { provider: 'local-file-system', read: true, write: true, delete: true, mkdir: true, rangedRead: true, resumableUpload: false, concurrency: { overwrite: 'unsupported', delete: 'best-effort-revision-check' }, tokenPersistence: 'none', overwrite: false, persistedHandles: false }; },
    async selectWorkspace(id) { workspaceId = id || 'root'; return workspaceId; },
    async list(parentId = workspaceId) {
      const parent = await getHandle(parentId); await permission(parent);
      const result = [];
      for await (const [name, handle] of parent.entries()) {
        const id = idsFor(handle); handles.set(id, handle); parents.set(id, parent);
        result.push(await metadata(id, handle));
      }
      return result;
    },
    async stat(id) { const handle = await getHandle(id); await permission(handle); return metadata(id, handle); },
    async read(id, { signal, range } = {}) {
      aborted(signal); const handle = await getHandle(id); await permission(handle);
      if (handle.kind !== 'file') throw new ProviderError('provider_error', 'Cannot read a directory.');
      contentRange(range);
      const file = await handle.getFile(); const start = range ? Number(range.start ?? 0) : 0;
      const end = range ? Number(range.end) + 1 : file.size;
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer()); aborted(signal); return bytes;
    },
    async write({ id, parentId = workspaceId, name, bytes, expectedRevision, signal, onProgress } = {}) {
      aborted(signal); const data = await asBytes(bytes);
      if (id) throw new ProviderError('conflict', 'The browser File System Access API does not provide atomic compare-and-swap; overwriting is disabled.');
      if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new TypeError('name must be a single safe file name');
      const parent = await getHandle(parentId); await permission(parent, true);
      let fileHandle;
      try { fileHandle = await parent.getFileHandle(name); throw new ProviderError('conflict', 'A file with this name already exists; local overwrite is disabled.'); }
      catch (error) { if (error instanceof ProviderError) throw error; if (error?.name !== 'NotFoundError') throw error; }
      aborted(signal);
      fileHandle = await parent.getFileHandle(name, { create: true });
      const writer = await fileHandle.createWritable({ keepExistingData: false });
      try { await writer.write(data); aborted(signal); await writer.close(); }
      catch (error) { await writer.abort?.().catch(() => {}); throw error; }
      const newId = idsFor(fileHandle); handles.set(newId, fileHandle); parents.set(newId, parent); onProgress?.(data.byteLength, data.byteLength);
      return metadata(newId, fileHandle);
    },
    async delete(id, { expectedRevision } = {}) {
      const handle = await getHandle(id); const parent = parents.get(id);
      if (!parent) throw new ProviderError('not_found', 'Local file parent is no longer available.');
      if (expectedRevision) {
        const current = await metadata(id, handle);
        if (current.revision !== expectedRevision) throw new ProviderError('conflict', 'Local file changed before deletion.');
      }
      await permission(parent, true); await handle.remove(); handles.delete(id); parents.delete(id);
    },
    async mkdir(parentId = workspaceId, name) {
      if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new TypeError('name must be a single safe folder name');
      const parent = await getHandle(parentId); await permission(parent, true);
      const handle = await parent.getDirectoryHandle(name, { create: true }); const id = idsFor(handle);
      handles.set(id, handle); parents.set(id, parent); return metadata(id, handle);
    }
  };
}

export function createMemoryProvider(files = []) {
  const entries = new Map();
  let revisionCounter = 0;
  let workspaceId = 'root';
  const putFile = (file, parentId = 'root') => {
    const id = makeId();
    entries.set(id, { id, name: file.name || 'file', parentId, mimeType: file.type || 'application/octet-stream', size: file.size || 0, bytesPromise: file.arrayBuffer ? file.arrayBuffer().then(buf => new Uint8Array(buf)) : Promise.resolve(new Uint8Array(file.bytes || [])), revision: `m${++revisionCounter}`, directory: false });
    return id;
  };
  for (const file of Array.from(files || [])) putFile(file);
  const get = id => { const item = entries.get(id); if (!item) throw new ProviderError('not_found', 'Memory file was not found.'); return item; };
  const metadata = item => record({ id: item.id, name: item.name, revision: item.revision, size: item.directory ? 0 : item.size || 0, mimeType: item.directory ? 'inode/directory' : item.mimeType, providerName: 'fallback' });
  return {
    provider: { name: 'fallback' },
    async connect() { return this.capabilities(); }, async disconnect() { entries.clear(); workspaceId = 'root'; },
    capabilities() { return { provider: 'file-input-memory', read: true, write: true, delete: true, mkdir: true, rangedRead: true, resumableUpload: false, concurrency: { overwrite: 'memory-revision', delete: 'memory-revision' }, tokenPersistence: 'memory-only', persists: false }; },
    async selectWorkspace(id) { workspaceId = id || 'root'; return workspaceId; },
    async list(parentId = workspaceId) { return Array.from(entries.values()).filter(item => item.parentId === parentId).map(metadata); },
    async stat(id) { return metadata(get(id)); },
    async read(id, { signal, range } = {}) {
      aborted(signal); const item = get(id); if (item.directory) throw new ProviderError('provider_error', 'Cannot read a directory.');
      contentRange(range);
      const bytes = await item.bytesPromise; aborted(signal);
      const start = range ? Number(range.start ?? 0) : 0; const end = range ? Number(range.end) + 1 : bytes.byteLength;
      return bytes.slice(start, end);
    },
    async write({ id, parentId = workspaceId, name, bytes, expectedRevision, signal, onProgress } = {}) {
      aborted(signal); const data = await asBytes(bytes); let item;
      if (id) {
        item = get(id);
        if (!expectedRevision || expectedRevision !== item.revision) throw new ProviderError('conflict', 'Memory file revision changed before overwrite.');
      } else {
        if (!name) throw new TypeError('name is required when creating a file');
        item = { id: makeId(), name, parentId, mimeType: 'application/octet-stream', directory: false };
      }
      item.bytesPromise = Promise.resolve(data.slice()); item.size = data.byteLength; item.revision = `m${++revisionCounter}`; entries.set(item.id, item);
      onProgress?.(data.byteLength, data.byteLength); return metadata(item);
    },
    async delete(id, { expectedRevision } = {}) {
      const item = get(id); if (expectedRevision && expectedRevision !== item.revision) throw new ProviderError('conflict', 'Memory file revision changed before deletion.'); entries.delete(id);
    },
    async mkdir(parentId = workspaceId, name) {
      if (!name) throw new TypeError('name is required');
      const item = { id: makeId(), parentId, name, directory: true, revision: `m${++revisionCounter}`, mimeType: 'inode/directory' }; entries.set(item.id, item); return metadata(item);
    }
  };
}

export const createFileInputMemoryProvider = files => createMemoryProvider(files);

export function createS3Provider() {
  const unavailable = () => { throw new ProviderError('provider_error', 'Browser S3 support is disabled until a paired companion capability is available. Permanent S3 credentials are not accepted.'); };
  return { connect: unavailable, disconnect: async () => {}, capabilities: () => ({ provider: 's3', available: false, reason: 'paired-companion-required', tokenPersistence: 'none' }), selectWorkspace: unavailable, list: unavailable, stat: unavailable, read: unavailable, write: unavailable, delete: unavailable, mkdir: unavailable };
}
