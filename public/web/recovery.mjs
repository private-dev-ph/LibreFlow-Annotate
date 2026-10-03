// Only encrypted records enter IndexedDB. Tokens and keys stay in memory.
export class RecoveryCache {
  constructor(workspaceId, indexedDB = globalThis.indexedDB) { this.workspaceId = workspaceId; this.indexedDB = indexedDB; this.memory = new Map(); }
  async db() {
    if (!this.indexedDB) return null;
    if (!this.database) this.database = await new Promise((resolve, reject) => { const r = this.indexedDB.open('libreflow-encrypted-recovery', 1); r.onupgradeneeded = () => r.result.createObjectStore('records'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    return this.database;
  }
  async operation(mode, run) {
    const db = await this.db(); if (!db) return run(null);
    return new Promise((resolve, reject) => { const tx = db.transaction('records', mode); const request = run(tx.objectStore('records')); tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Recovery write aborted')); });
  }
  async put(id, value) { if (!value?.encrypted) throw new Error('Recovery requires ciphertext'); const k = `${this.workspaceId}:${id}`; await this.operation('readwrite', s => s ? s.put(value, k) : this.memory.set(k, structuredClone(value))); }
  async delete(id) { const k = `${this.workspaceId}:${id}`; await this.operation('readwrite', s => s ? s.delete(k) : this.memory.delete(k)); }
  async entries() {
    const db = await this.db(); if (!db) return [...this.memory].filter(([k]) => k.startsWith(`${this.workspaceId}:`)).map(([,v]) => structuredClone(v));
    return new Promise((resolve, reject) => { const tx = db.transaction('records'); const values = []; const r = tx.objectStore('records').openCursor(); r.onsuccess = () => { const c = r.result; if (!c) return; if (String(c.key).startsWith(`${this.workspaceId}:`)) values.push(c.value); c.continue(); }; tx.oncomplete = () => resolve(values); tx.onerror = () => reject(tx.error); });
  }
  close() { this.database?.close(); this.database = null; this.memory.clear(); }
}
