import test from 'node:test';
import assert from 'node:assert/strict';
import { createS3CompanionProvider } from '../public/web/providers/s3-companion.mjs';

test('S3 adapter uses paired routes, conditional revisions and rejects paths and deletes',async()=>{
 const calls=[];
 const companion={async storageRequest(path,options={}){calls.push({path,options});return {id:'opaque-id',name:'encrypted.json',revision:'etag-1',size:3,mimeType:'application/octet-stream'};}};
 const p=createS3CompanionProvider({companion});
 await assert.rejects(p.stat('id'),e=>e.code==='auth_expired');await p.connect();
 await assert.rejects(p.selectWorkspace('other'),/one configured/);
 await assert.rejects(p.write({id:'id',bytes:new Uint8Array([1])}),e=>e.code==='conflict');
 await assert.rejects(p.write({name:'../escape',bytes:new Uint8Array([1])}),/safe path/);
 const saved=await p.write({id:'opaque-id',expectedRevision:'etag-1',bytes:new Uint8Array([1,2,3])});assert.equal(saved.revision,'etag-1');
 const url=new URL(calls[0].path,'http://127.0.0.1:8787');assert.equal(url.pathname,'/storage/s3/write');assert.equal(url.searchParams.get('expectedRevision'),'etag-1');assert.equal(calls[0].options.method,'POST');
 await assert.rejects(p.delete('id'),e=>e.code==='conflict');await p.disconnect();await assert.rejects(p.stat('id'),e=>e.code==='auth_expired');
});
test('S3 errors preserve recoverable conflict/quota/authentication state',async()=>{
 for(const [status,code] of [[401,'auth_expired'],[404,'not_found'],[412,'conflict'],[507,'quota']]){
  const p=createS3CompanionProvider({companion:{async storageRequest(){throw Object.assign(new Error('synthetic provider failure'),{status});}}});await p.connect();await assert.rejects(p.stat('opaque'),e=>e.code===code&&e.status===status);
 }
});
