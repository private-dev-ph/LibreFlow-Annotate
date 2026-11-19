const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { normalizeClassIds, validateClassSelectionResponse } = require('../../lib/inference-classes');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-classes-'));
for (const [env, dir] of [['LIBREFLOW_DATA_DIR','data'], ['LIBREFLOW_MODELS_DIR','models'], ['LIBREFLOW_UPLOADS_DIR','uploads']]) {
  process.env[env] = path.join(temp, dir); fs.mkdirSync(process.env[env]);
}
after(() => fs.rmSync(temp, { recursive: true, force: true }));
test('class selections reject ambiguous input and acknowledge the exact set', () => {
  assert.equal(normalizeClassIds(undefined), null);
  assert.deepEqual(normalizeClassIds([2, 1, 2]), [1, 2]);
  for (const bad of [[], '1', [true], ['1'], [-1], [1.1], [null]]) assert.throws(() => normalizeClassIds(bad));
  validateClassSelectionResponse({ class_ids: [1], results: [] }, [1]);
  for (const bad of [{ results: [] }, { class_ids: [0], results: [] }, { class_ids: [1], results: [{class_id:0}] }]) {
    assert.throws(() => validateClassSelectionResponse(bad, [1]));
  }
});

test('authenticated class catalog and normal/tiled selected inference fail closed', async () => {
  const write = (name, data) => fs.writeFileSync(path.join(process.env.LIBREFLOW_DATA_DIR, name), JSON.stringify(data));
  write('projects.json', [{ id:'p', userId:'owner', collaborators:[{userId:'member'}] }, {id:'other',userId:'stranger'}]);
  write('models.json', [{id:'m',projectId:'p',userId:'owner',type:'detection',filename:'m.onnx',sharedWithCollaborators:true}, {id:'private',projectId:'p',userId:'owner',filename:'m.onnx'}, {id:'escape',projectId:'p',userId:'owner',filename:'../outside.onnx'}]);
  write('images.json', [{id:'i',projectId:'p',filename:'i.png',width:2048,height:1024}]);
  fs.writeFileSync(path.join(process.env.LIBREFLOW_MODELS_DIR, 'm.onnx'), 'fixture');
  fs.writeFileSync(path.join(process.env.LIBREFLOW_UPLOADS_DIR, 'i.png'), 'fixture');
  let requests = [], mode = 'ok';
  const detection = id => ({class_id:id,label:`Class ${id}`,confidence:.9,type:'bbox',data:{x:0,y:0,width:10,height:10}});
  const upstream = http.createServer(async (req,res) => {
    const chunks=[];for await (const chunk of req) chunks.push(chunk);
    const payload=JSON.parse(Buffer.concat(chunks));requests.push({url:req.url,payload});
    let body;
    if(req.url==='/model-info') body={task:'detect',classes:[{id:0,name:'Object A'},{id:1,name:'Object B'},{id:2,name:'Object C'}],private_path:'must not leak'};
    else if(mode==='unknown') {res.statusCode=422;body={detail:'Unknown model class ID: 999'};}
    else body={results:mode==='unexpected'?[detection(0)]:mode==='empty'?[]:(payload.class_ids||[0,1,2]).map(detection),...(mode==='old'?{}:{class_ids:payload.class_ids}),...(payload.tiling?{tiling:{enabled:true}}:{})};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  process.env.INFER_SERVER_URL=`http://127.0.0.1:${upstream.address().port}`;
  const express=require('express'), app=express();
  app.use(express.json());app.use((req,res,next)=>{req.session={userId:req.headers['x-user']||'owner',username:'tester'};next();});
  app.use('/api/models',require('../../routes/models'));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const infer=(body={},user='owner')=>fetch(`${base}/api/models/m/infer`,{method:'POST',headers:{'content-type':'application/json','x-user':user},body:JSON.stringify({imageId:'i',...body})});
  try {
    const catalog=await fetch(`${base}/api/models/m/classes?projectId=p`,{headers:{'x-user':'member'}});
    assert.equal(catalog.status,200);assert.deepEqual(await catalog.json(),{task:'detect',classes:[{id:0,name:'Object A'},{id:1,name:'Object B'},{id:2,name:'Object C'}]});
    const before=requests.length;
    for(const [id,query,user] of [['m','p','stranger'],['m','other','owner'],['private','p','member'],['escape','p','owner']]) {
      assert.equal((await fetch(`${base}/api/models/${id}/classes?projectId=${query}`,{headers:{'x-user':user}})).status,404);
    }
    assert.equal(requests.length,before);
    for(const bad of [[],[true],['1'],[1.5],[-1]]) assert.equal((await infer({classIds:bad})).status,400);
    assert.equal(requests.length,before);
    for(const tiling of [undefined,{enabled:true}]) {
      const response=await infer({classIds:[2,1],confThreshold:.6,tiling},'member');
      assert.equal(response.status,200);const result=await response.json();
      assert.equal(result.results.length,2,'overlapping different selected classes survive');
      assert.deepEqual(requests.at(-1).payload.class_ids,[1,2]);assert.equal(requests.at(-1).payload.conf_threshold,.6);
      assert.equal(result.results[0].source,'model');
    }
    mode='empty';assert.deepEqual((await (await infer({classIds:[1]})).json()).results,[]);
    for(const invalid of ['old','unexpected']) {mode=invalid;assert.equal((await infer({classIds:[1]})).status,502);}
    mode='unknown';assert.equal((await infer({classIds:[999]})).status,422);
    mode='ok';await infer();assert.equal(requests.at(-1).payload.class_ids,null);
    const {inferImage}=require('../../lib/inference-client');
    const queued=await inferImage({userId:'owner',projectId:'p',modelId:'m',imageId:'i',classIds:[1]});
    assert.deepEqual(queued.class_ids,[1]);
    mode='old';await assert.rejects(()=>inferImage({userId:'owner',projectId:'p',modelId:'m',imageId:'i',classIds:[1]}),/did not confirm/);
  } finally {await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>upstream.close(resolve));}
});
