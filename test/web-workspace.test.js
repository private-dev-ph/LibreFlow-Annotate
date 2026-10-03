const test = require('node:test');
const assert = require('node:assert/strict');
let modules;
async function setup() { return modules ||= Promise.all([import('../public/web/workspace.mjs'), import('../public/web/crypto.mjs'), import('../public/web/recovery.mjs')]); }
class MemoryProvider {
  constructor() { this.name = 'memory'; this.files = new Map(); this.online = true; }
  check() { if (!this.online) throw new Error('Offline'); }
  async list() { this.check(); return [...this.files.values()].map(({data,...ref}) => ref); }
  async write({ name, bytes }) { this.check(); const id = crypto.randomUUID(); const ref = {id,name,revision:'1',data:new Uint8Array(bytes)}; this.files.set(id,ref); return ref; }
  async read(id) { this.check(); if (!this.files.has(id)) throw new Error('Missing file'); return this.files.get(id).data; }
  async disconnect() {}
}
const password = 'a long test passphrase';
test('workspace manifests, incorrect keys and tampered ciphertext fail closed', async()=> {
 const [{Workspace,validateManifest}, {open,seal,encode}] = await setup();
 assert.throws(()=>validateManifest({schemaVersion:2}), /unsupported/);
 const p=new MemoryProvider(); const w=await Workspace.create(p,'root',password);
 await assert.rejects(Workspace.connect(p,'root','incorrect test phrase'), /Incorrect key/);
 const box=await seal(w.key,encode('private'), 'bound-context');
 await assert.rejects(open(w.key,box,'wrong-context'),/corrupt/);
 box.ciphertext=box.ciphertext.slice(0,-4)+'AAAA'; await assert.rejects(open(w.key,box,'bound-context'),/corrupt/);
 await assert.rejects(Workspace.create(p,'root',password),/already contains/);
});
test('encrypted records are partitioned per entity, forked saves preserve both states and immutable revisions', async()=> {
 const [{Workspace}] = await setup(); const p=new MemoryProvider();const w=await Workspace.create(p,'root',password);const id=crypto.randomUUID();
 await w.put('annotation',id,[{label:'secret label'}]);
 const other=await Workspace.connect(p,'root',password);
 await w.put('annotation',id,[{label:'first client'}]);
 await other.put('annotation',id,[{label:'second client'}]);
 assert.equal(other.status.state,'conflict'); assert.throws(()=>other.get('annotation',id),/Concurrent/);
 assert.equal(other.history('annotation',id).length,3);
 await other.put('annotation',id,[{label:'resolved'}],{resolve:true}); assert.equal(other.get('annotation',id)[0].label,'resolved');
 assert.ok([...p.files.values()].every(f=>!new TextDecoder().decode(f.data).includes('secret label')));
 const version=crypto.randomUUID();await other.put('version',version,{images:[]}); await assert.rejects(other.put('version',version,{}),/immutable/);
 await assert.rejects(other.put('project','../bad',{}),/Invalid entity/);
});
test('offline edits recover from ciphertext and sync without silently losing revision parents', async()=> {
 const [{Workspace},, {RecoveryCache}] = await setup(); const p=new MemoryProvider();const w=await Workspace.create(p,'root',password); const id=crypto.randomUUID();
 w.offline=true;await w.put('annotation',id,[{label:'offline private'}]);
 const recovered=new Workspace(p,'root',w.manifest,w.key,w.cache);await recovered.recover();assert.equal(recovered.status.pending,1);assert.equal(recovered.get('annotation',id)[0].label,'offline private');
 await recovered.sync();assert.equal(recovered.status.state,'saved');assert.equal((await recovered.cache.entries()).length,0);
 await assert.rejects(new RecoveryCache('id').put('plaintext',{label:'secret'}),/ciphertext/);
 p.online=false;await assert.rejects(recovered.put('annotation',id,[]),/Offline/);assert.equal(recovered.status.pending,1);p.online=true;await recovered.sync();assert.deepEqual(recovered.get('annotation',id),[]);
});
test('chunked encrypted assets verify integrity, survive portable migration and abort transfers', async()=> {
 const [{Workspace,importPortable}] = await setup();const p=new MemoryProvider();const w=await Workspace.create(p,'root',password);
 const file=new Blob(['private image bytes'],{type:'image/png'});file.name='malicious <img>.png';const asset=await w.manageAsset(file);const id=crypto.randomUUID();await w.put('image',id,{asset});
 let data=[];for await(const chunk of w.readAsset(asset))data.push(...chunk);assert.equal(new TextDecoder().decode(Uint8Array.from(data)),'private image bytes');
 const backup=await w.exportPortable();const next=new MemoryProvider();await importPortable(next,'root',backup,password);const migrated=await Workspace.connect(next,'root',password);let output=[];for await(const c of migrated.readAsset(migrated.get('image',id).asset))output.push(...c);assert.deepEqual(output,data);
 const controller=new AbortController();controller.abort();await assert.rejects(w.manageAsset(file,{signal:controller.signal}),/abort/i);
 const corrupt=structuredClone(asset);corrupt.chunks[0].hash='a'.repeat(64);await assert.rejects(async()=>{for await(const c of w.readAsset(corrupt))void c;},/Invalid asset/);
 const bad=structuredClone(backup);bad.schemaVersion=2;await assert.rejects(importPortable(new MemoryProvider(),'root',bad,password),/Unsupported/);
});
