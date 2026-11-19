const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const AdmZip = require('adm-zip');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-version-management-'));
const data = path.join(root, 'data'), versions = path.join(root, 'versions');
for (const folder of [data, versions, path.join(root,'uploads'), path.join(root,'datasets')]) fs.mkdirSync(folder, {recursive:true});
process.env.LIBREFLOW_DATA_DIR = data;
process.env.LIBREFLOW_VERSIONS_DIR = versions;
process.env.LIBREFLOW_UPLOADS_DIR = path.join(root, 'uploads');
process.env.LIBREFLOW_DATASETS_DIR = path.join(root, 'datasets');
const { stableStringify } = require('../../lib/dataset-lifecycle');
const { acquireVersionOperation } = require('../../lib/version-operations');
const write = (name, value) => fs.writeFileSync(path.join(data,name),JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(id, sourceType = 'project', sourceId = 'one', sequence = 1, large = false) {
  const dir = path.join(versions,id); fs.mkdirSync(path.join(dir,'images'),{recursive:true});
  const bytes = large ? crypto.randomBytes(16 * 1024 * 1024) : Buffer.from('a small immutable image');
  fs.writeFileSync(path.join(dir,'images','sample.png'),bytes);
  const manifest = { id, name:'Fixture', sequence, schema:'libreflow.dataset-version/v1', source:{ type:sourceType, id:sourceId, name:'Source' },
    classes:[{name:'part'}], images:[{id:'image',path:'images/sample.png',originalName:'sample.png',contentHash:sha(bytes),size:bytes.length,width:100,height:100,split:'train'}],
    annotations:[{id:'box',imageId:'image',label:'part',type:'bbox',data:{x:1,y:2,width:3,height:4}}],
    stats:{images:1,annotations:1,bytes:bytes.length},splits:{counts:{train:1,valid:0,test:0}},contentHash:'fixture' };
  manifest.manifestHash=sha(stableStringify(manifest));
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  return {id,sourceType,sourceId,sequence,name:'Fixture',stats:manifest.stats};
}
write('projects.json',[{id:'one',name:'One',userId:'owner',collaborators:[{userId:'member'}]},{id:'two',name:'Two',userId:'owner',collaborators:[]}]);
write('datasets.json',[{id:'dataset',userId:'owner',sourceProjectId:'one',sharedWithCollaborators:true,images:[]}]);
write('users.json',[]);write('images.json',[]);write('annotations.json',[]);
write('dataset_versions.json',[fixture('version-one'),fixture('version-other','project','two'),fixture('version-dataset','dataset','dataset'),fixture('version-large','project','one',2,true)]);
const express = require('express');
const router = require('../../routes/dataset-lifecycle');

test('version operations prevent concurrent deletion without blocking unrelated versions', () => {
  const first=acquireVersionOperation('lock','download'),second=acquireVersionOperation('lock','download');
  assert.throws(()=>acquireVersionOperation('lock','delete'),{code:'VERSION_BUSY'});
  first(); first(); assert.throws(()=>acquireVersionOperation('lock','delete'),{code:'VERSION_BUSY'});
  const other=acquireVersionOperation('other','delete'); other();second();
  const exclusive=acquireVersionOperation('lock','delete');
  assert.throws(()=>acquireVersionOperation('lock','download'),{code:'VERSION_BUSY'});
  exclusive(); const retry=acquireVersionOperation('lock','download');retry();
});

test('version routes stream archives, enforce deletion ownership and retain source data', async t => {
  const app=express();app.use(express.json());app.use((req,res,next)=>{
    req.session={userId:req.get('x-test-user')||'owner',username:'fixture'};
    if(req.get('x-test-scope'))req.authContext={type:'api_key',userId:'owner',scopes:req.get('x-test-scope').split(','),projectIds:['one']};
    next();
  });app.use('/api/dataset-lifecycle',router);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));assert.ok(root.startsWith(path.join(os.tmpdir(),'libreflow-version-management-')));fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}/api/dataset-lifecycle`;
  const get=(url,options={})=>fetch(base+url,options);
  const endpoint='/project/one/versions/version-one';
  const sourceBefore=fs.readFileSync(path.join(data,'projects.json'));
  assert.equal((await(await get('/project/one/versions')).json())[0].canDelete,true);
  assert.equal((await(await get('/project/one/versions',{headers:{'x-test-user':'member'}})).json())[0].canDelete,false);
  assert.equal((await get(endpoint,{method:'DELETE',headers:{'x-test-user':'member'}})).status,403);
  assert.equal((await get(endpoint,{method:'DELETE',headers:{'x-test-scope':'versions:read'}})).status,403);
  assert.equal((await get('/project/one/versions/version-other',{method:'DELETE'})).status,404);
  const lock=acquireVersionOperation('version-one','download');
  assert.equal((await get(endpoint,{method:'DELETE'})).status,409);lock();
  assert.equal((await get(endpoint+'/download-check?format=unknown')).status,400);
  let liveReads=0;const originalRead=fs.readFileSync;
  fs.readFileSync=function(file,...args){if(['images.json','annotations.json'].some(name=>String(file)===path.join(data,name)))liveReads++;return originalRead.call(this,file,...args);};
  let check;
  try{check=await get(endpoint+'/download-check?format=roboflow&images=true&includeNull=false');}finally{fs.readFileSync=originalRead;}
  assert.equal(liveReads,0,'saved-version downloads do not reload live annotations');
  assert.equal(check.status,200);const details=await check.json();
  assert.equal(details.imageCount,1);assert.ok(details.estimatedBytes>0);
  assert.match(details.downloadUrl,/^\/api\/dataset-lifecycle\/project\/one\/versions\/version-one\/download\?/);
  const response=await fetch(new URL(details.downloadUrl,base));assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/zip');
  assert.match(response.headers.get('content-disposition'),/attachment/);
  assert.equal(response.headers.get('content-length'),null,'streamed response has no full-ZIP buffer length');
  const zip=new AdmZip(Buffer.from(await response.arrayBuffer()));
  assert.ok(zip.getEntry('data.yaml'));
  assert.equal(zip.getEntries().filter(e=>e.entryName.endsWith('.png')).length,1,'only one training copy');
  const head=await get(endpoint+'/download?format=roboflow',{method:'HEAD'});assert.equal(head.status,200);
  assert.equal(await head.text(),'');
  const largeEndpoint='/project/one/versions/version-large';
  const paused=await new Promise((resolve,reject)=>{const request=http.get(base+largeEndpoint+'/download?format=roboflow',response=>{response.pause();resolve({request,response});});request.on('error',reject);});
  assert.equal((await get(largeEndpoint,{method:'DELETE'})).status,409,'active streamed download retains its lease while other HTTP requests remain responsive');
  paused.response.destroy();paused.request.destroy();
  const deadline=Date.now()+5000;let released=false;
  while(Date.now()<deadline&&!released){try{const unlock=acquireVersionOperation('version-large','delete');unlock();released=true;}catch{await new Promise(r=>setTimeout(r,20));}}
  assert.equal(released,true,'canceled download releases its lease');
  assert.equal((await get(largeEndpoint,{method:'DELETE'})).status,200);
  const deletion=await get(endpoint,{method:'DELETE'});assert.equal(deletion.status,200);assert.equal((await deletion.json()).deleted,true);
  assert.equal(fs.existsSync(path.join(versions,'version-one')),false);
  assert.equal(fs.existsSync(path.join(versions,'version-other','manifest.json')),true);
  assert.deepEqual(fs.readFileSync(path.join(data,'projects.json')),sourceBefore);
  assert.equal((await get(endpoint+'/download-check')).status,404);
  assert.equal((await get(endpoint,{method:'DELETE'})).status,404);
  assert.equal((await get('/dataset/dataset/versions/version-dataset',{method:'DELETE',headers:{'x-test-user':'member'}})).status,403);
  assert.equal((await get('/dataset/dataset/versions/version-dataset',{method:'DELETE'})).status,200);
});
