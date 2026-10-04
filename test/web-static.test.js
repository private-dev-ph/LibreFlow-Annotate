const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
test('static artifact excludes Express routes, host persistence and legacy REST scripts',()=>{
 execFileSync(process.execPath,['scripts/build-web.js']);const root=path.resolve('dist/web');const html=fs.readFileSync(path.join(root,'index.html'),'utf8');assert.ok(html.includes('./app.mjs'));assert.ok(!html.includes('api.js'));assert.ok(!html.includes('app.js'));
 for(const name of ['server.js','routes','lib','data','uploads','models','datasets','versions'])assert.equal(fs.existsSync(path.join(root,name)),false,name);
 const csp=fs.readFileSync(path.join(root,'_headers'),'utf8');assert.match(csp,/connect-src https:/);assert.ok(!/connect-src[^;]*'self'/.test(csp));assert.match(csp,/form-action 'none'/);
 const source=fs.readFileSync(path.join(root,'app.mjs'),'utf8');assert.ok(!source.includes('innerHTML'));assert.ok(!source.includes('/api/'));assert.ok(!source.includes('localStorage'));
});
test('web API preserves annotation contract, capability-gates server identities and snapshots rich geometry',async()=>{
 const {WebAPI}=await import('../public/web/api.mjs');const records=new Map();const history=[];const w={manifest:{id:'owner'},list:type=>[...records].filter(([k])=>k.startsWith(type+':')).map(([k,value])=>({id:k.split(':')[1],value})),get:(t,id)=>records.get(`${t}:${id}`),put:async(t,id,v)=>{records.set(`${t}:${id}`,structuredClone(v));history.push({t,id,v});},disconnect:async()=>{}};
 const api=new WebAPI(w);const project=await api.createProject('<img onerror=x>');assert.equal(project.name,'<img onerror=x>');const image=crypto.randomUUID();await w.put('image',image,{id:image,projectId:project.id,asset:{mode:'linked'}});
 const shapes=[{id:crypto.randomUUID(),type:'polygon',label:'rich',data:[{x:1,y:2},{x:3,y:4},{x:5,y:6}]}];await api.saveAnnotations(image,shapes);assert.deepEqual(await api.getAnnotations(image),shapes);await api.addReviewComment(image,'<script>x</script>');const version=await api.createVersion(project.id);assert.deepEqual(version.images[0].annotations,shapes);assert.equal(version.images[0].review.comments[0].message,'<script>x</script>');assert.equal(api.capabilities.accounts,false);assert.throws(()=>api.unsupported('Collaboration'),/self-hosted/);
});
