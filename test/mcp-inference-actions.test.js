'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),sharp=require('sharp');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'libreflow-draft-actions-'));
process.env.LIBREFLOW_DATA_DIR=path.join(root,'data');
process.env.LIBREFLOW_UPLOADS_DIR=path.join(root,'uploads');
process.env.LIBREFLOW_MODELS_DIR=path.join(root,'models');
process.env.LIBREFLOW_MCP_WRITES_ENABLED='true';
for(const name of ['data','uploads','models'])fs.mkdirSync(path.join(root,name));
const {dataFile,readJson,writeJson}=require('../lib/json-store');
const policy=require('../lib/mcp-connections'),ops=require('../lib/mcp-operations'),actions=require('../lib/mcp-inference-actions');
const jobs=require('../lib/job-runner'),{imageState}=require('../lib/mcp-source-state');
const {appendAnnotations,validateAdditions}=require('../lib/annotation-commands');
const put=(name,value)=>writeJson(dataFile(name+'.json'),value);
const A={id:'old-A',imageId:'image',label:'A',type:'bbox',data:{x:2,y:2,width:10,height:10},authorId:'original',custom:'retain verbatim'};
const B={label:'B',type:'bbox',data:{x:25,y:25,width:12,height:12},confidence:.9};
function connect(){return policy.authenticateConnection(policy.createConnection('owner',{name:'Fixture AI',projectIds:['p'],scopes:['mcp:projects:read','mcp:annotations:read','mcp:annotations:append','mcp:models:read','mcp:inference:run','mcp:jobs:read','mcp:jobs:cancel']}).token);}
function approve(request){ops.approveProposal('owner',request.id,request.digest);return {projectId:'p',operationId:request.id};}
async function finished(id){for(let i=0;i<300;i++){const job=jobs.getJob('owner',id);if(jobs.TERMINAL_STATUSES.has(job.status))return job;await new Promise(r=>setTimeout(r,10));}throw Error('job did not finish');}
test.beforeEach(()=>{
 put('users',[{id:'owner',username:'Owner'}]);put('projects',[{id:'p',userId:'owner',labelClasses:['A','B']}]);
 put('images',[{id:'image',projectId:'p',filename:'image.png',width:100,height:100,isNull:false,reviewStatus:'approved'}]);
 put('annotations',[A]);put('models',[{id:'model',projectId:'p',userId:'owner',name:'Detector',filename:'model.onnx',type:'detection'}]);
 for(const name of ['reviews','annotation-revisions','audit-events','mcp-operations','mcp-connections','mcp-inference-drafts','jobs','webhook-deliveries'])put(name,[]);
 fs.writeFileSync(path.join(root,'uploads','image.png'),'fixture');fs.writeFileSync(path.join(root,'models','model.onnx'),'fixture');
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('class B tiled inference produces drafts and appends only after separate approval',async()=>{
 let seen;actions.registerInferenceJobs({infer:async input=>{seen=input;return {results:[B]};}});
 const principal=connect(),preview=await actions.previewInference(principal,{projectId:'p',requestKey:'run',modelId:'model',imageIds:['image'],classIds:[1],confThreshold:.6,tiling:{enabled:true}});
 assert.throws(()=>actions.startInference(principal,{projectId:'p',operationId:preview.id}),e=>e.code==='APPROVAL_REQUIRED');
 const started=actions.startInference(principal,approve(preview)),completed=await finished(started.jobId);
 assert.equal(completed.status,'completed',completed.error);assert.deepEqual(seen.classIds,[1]);assert.equal(seen.confThreshold,.6);assert.equal(seen.tiling.enabled,true);
 assert.deepEqual(readJson(dataFile('annotations.json')),[A]);assert.equal(imageState('p','image').image.reviewStatus,'approved');
 const draft=actions.getDraft(principal,{projectId:'p',draftId:completed.result.draftIds[0]});assert.deepEqual(draft.items,[B]);
 const append=await actions.proposeAnnotations(principal,{projectId:'p',requestKey:'append',draftId:draft.draftId});
 assert.throws(()=>actions.applyAnnotations(principal,{projectId:'p',operationId:append.id}),e=>e.code==='APPROVAL_REQUIRED');
 const result=actions.applyAnnotations(principal,approve(append));assert.equal(result.added,1);
 assert.deepEqual(readJson(dataFile('annotations.json'))[0],A);
 assert.equal(imageState('p','image').image.reviewStatus,'in_progress');assert.equal(readJson(dataFile('reviews.json'))[0].status,'in_progress');
 assert.equal(readJson(dataFile('annotations.json'))[1].provenance.operationId,append.id);
 assert.deepEqual(actions.applyAnnotations(principal,{projectId:'p',operationId:append.id}),result);
 assert.equal(readJson(dataFile('annotations.json')).length,2);assert.equal(readJson(dataFile('annotation-revisions.json')).length,2);
});
test('empty drafts preserve null and review states when approved',async()=>{
 put('images',[{id:'image',projectId:'p',filename:'image.png',width:100,height:100,isNull:true,reviewStatus:'approved'}]);
 const principal=connect();const revision=imageState('p','image').revision;
 const request=await actions.proposeAnnotations(principal,{projectId:'p',imageId:'image',expectedStateRevision:revision,shapes:[],requestKey:'empty'});
 assert.equal(actions.applyAnnotations(principal,approve(request)).added,0);assert.equal(imageState('p','image').revision,revision);
 assert.equal(readJson(dataFile('annotation-revisions.json')).length,0);
});
test('stale approved additions and invalid native geometry cannot mutate metadata',async()=>{
 const principal=connect(),current=imageState('p','image');
 for(const bad of [{...B,id:'chosen'},{...B,label:'Unknown'},{...B,data:{x:99,y:5,width:10,height:10}},{...B,data:{x:'1',y:1,width:2,height:2}}])
   assert.throws(()=>validateAdditions({shapes:[bad],image:current.image,project:current.project}));
 const r=await actions.proposeAnnotations(principal,{projectId:'p',imageId:'image',expectedStateRevision:current.revision,shapes:[B],requestKey:'stale'});approve(r);
 put('annotations',[A,{...B,id:'human',imageId:'image'}]);
 assert.throws(()=>actions.applyAnnotations(principal,{projectId:'p',operationId:r.id}),e=>e.code==='SOURCE_CHANGED');
 assert.equal(readJson(dataFile('annotations.json')).length,2);
});
test('outer transaction failure rolls back annotations, image, review, audit and history',()=>{
 const current=imageState('p','image');const before=fs.readdirSync(process.env.LIBREFLOW_DATA_DIR).filter(x=>x.endsWith('.json')).map(name=>[name,fs.readFileSync(dataFile(name),'utf8')]);
 assert.throws(()=>require('../lib/data-command').runDataCommand(()=>{
   appendAnnotations({projectId:'p',imageId:'image',expectedStateRevision:current.revision,shapes:[B],actorId:'owner',connectionId:'test',operationId:'test'});
   throw Error('after history failure');
 }),/after history failure/);
 for(const [name,value]of before)assert.equal(fs.readFileSync(dataFile(name),'utf8'),value,name);
});
test('source edits during inference prevent saving a stale draft',async()=>{
 actions.registerInferenceJobs({infer:async()=>{put('annotations',[A,{...B,id:'human',imageId:'image'}]);return{results:[B]};}});
 const principal=connect(),preview=await actions.previewInference(principal,{projectId:'p',requestKey:'changed',modelId:'model',imageIds:['image']});
 const job=actions.startInference(principal,approve(preview));assert.equal((await finished(job.jobId)).status,'failed');
 assert.equal(readJson(dataFile('mcp-inference-drafts.json')).length,0);
});
test('missing image dimensions resolve from bounded metadata without mutating images and persist in proposals',async()=>{
 const png=await sharp({create:{width:40,height:20,channels:3,background:'#284358'}}).withMetadata({orientation:6}).png().toBuffer();
 fs.writeFileSync(path.join(root,'uploads','image.png'),png);
 put('images',[{id:'image',projectId:'p',filename:'image.png',isNull:false,reviewStatus:'approved'}]);
 const before=fs.readFileSync(dataFile('images.json'),'utf8'),principal=connect();
 const query=require('../lib/mcp-queries').createQueryService(policy);
 const annotations=await query.callTool(principal,'libreflow_get_annotations',{projectId:'p',imageId:'image'});
 assert.equal(annotations.width,20);assert.equal(annotations.height,40);
 assert.equal(fs.readFileSync(dataFile('images.json'),'utf8'),before);
 const inference=await actions.previewInference(principal,{projectId:'p',requestKey:'nodims-run',modelId:'model',imageIds:['image']});
 const inferencePayload=ops.getInternalProposal(principal,'p',inference.id).payload;
 assert.deepEqual(inferencePayload.images[0].dimensions,{width:20,height:40});
 const proposal=await actions.proposeAnnotations(principal,{projectId:'p',requestKey:'nodims-append',imageId:'image',expectedStateRevision:imageState('p','image').revision,shapes:[{label:'B',type:'bbox',data:{x:1,y:1,width:5,height:5}}]});
 assert.deepEqual(ops.getInternalProposal(principal,'p',proposal.id).payload.dimensions,{width:20,height:40});
 approve(proposal);require('../lib/mcp-image-metadata').clearMetadataCache();
 assert.equal(actions.applyAnnotations(principal,{projectId:'p',operationId:proposal.id}).added,1);
 assert.equal(fs.readFileSync(dataFile('images.json'),'utf8').includes('"width"'),false);
});
test('corrupt image metadata fails with bounded invalid-argument error',async()=>{
 const principal=connect();put('images',[{id:'image',projectId:'p',filename:'image.png',isNull:false}]);fs.writeFileSync(path.join(root,'uploads','image.png'),Buffer.from('not an image'));
 await assert.rejects(actions.previewInference(principal,{projectId:'p',requestKey:'corrupt',modelId:'model',imageIds:['image']}),error=>error.code==='INVALID_ARGUMENT');
});
test('inference response reader enforces byte limits before parsing',async()=>{
 const {readResponseText}=require('../lib/inference-client');
 await assert.rejects(readResponseText(new Response('x'.repeat(1025)),1024),e=>e.code==='LIMIT_EXCEEDED');
 assert.equal(await readResponseText(new Response('{}'),1024),'{}');
});


test('tool schemas and browser approval endpoints enforce the complete action contract',async t=>{
 const express=require('express'),{once}=require('node:events');
 const queries=require('../lib/mcp-queries').createQueryService(policy);
 const principal=connect();
 const tools=queries.listTools(principal);
 assert.equal(tools.find(tool=>tool.name==='libreflow_propose_annotations').action,true);
 const request=await queries.callTool(principal,'libreflow_propose_annotations',{projectId:'p',requestKey:'protocol',imageId:'image',expectedStateRevision:imageState('p','image').revision,shapes:[B]});
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.session=req.get('x-fixture-user')?{userId:req.get('x-fixture-user')}:{};next();});
 app.use(require('../lib/security-middleware').createOriginPolicy({production:true,allowedOrigins:['https://fixture.test']}).csrf);
 app.use('/api/mcp/connections',require('../routes/mcp-connections'));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const url='http://127.0.0.1:'+server.address().port+'/api/mcp/connections/requests/'+request.id+'/approve';
 async function post(headers,body={digest:request.digest}){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});}
 assert.equal((await post({'x-fixture-user':'owner'})).status,403);
 assert.equal((await post({'x-fixture-user':'owner',Origin:'https://fixture.test',Authorization:'Bearer client-token'})).status,401);
 assert.equal((await post({Origin:'https://fixture.test'})).status,401);
 assert.equal((await post({'x-fixture-user':'owner',Origin:'https://fixture.test'},{digest:request.digest,shapes:[]})).status,400);
 const previewUrl=url.replace(/approve$/, 'annotations');
 assert.equal((await fetch(previewUrl,{headers:{Authorization:'Bearer client-token'}})).status,401);
 assert.equal((await fetch(previewUrl,{headers:{'x-fixture-user':'outsider'}})).status,401);
 const imagePreview=await fetch(previewUrl,{headers:{'x-fixture-user':'owner'}});assert.equal(imagePreview.status,200);
 const shown=await imagePreview.json();assert.deepEqual(shown.shapes,[B]);assert.equal(shown.existingCount,1);assert.equal(shown.image.url,'/uploads/image.png');
 const approved=await post({'x-fixture-user':'owner',Origin:'https://fixture.test'});assert.equal(approved.status,200);
 const result=await queries.callTool(principal,'libreflow_apply_annotation_proposal',{projectId:'p',operationId:request.id});assert.equal(result.added,1);
 await assert.rejects(queries.callTool(principal,'libreflow_propose_annotations',{projectId:'p',requestKey:'bad',shapes:[],unexpected:true}),e=>e.code==='INVALID_ARGUMENT');
});

