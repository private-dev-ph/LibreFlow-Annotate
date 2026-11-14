'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'libreflow-managed-jobs-'));
process.env.LIBREFLOW_DATA_DIR=root;
const {dataFile,writeJson}=require('../lib/json-store');
writeJson(dataFile('users.json'),[{id:'owner'}]);writeJson(dataFile('projects.json'),[{id:'p',userId:'owner'}]);
const jobs=require('../lib/job-runner');
async function until(predicate){for(let n=0;n<100;n++){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,10))}throw Error('Job did not reach expected state')}
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('managed jobs use the existing queue and retain their bounded result',async()=>{
 jobs.registerManagedJob('mcp_version',async ctx=>{ctx.markItem('one',{status:'succeeded'});return {versionId:'version-one'}});
 const created=jobs.createManagedJob({type:'mcp_version',name:'Version build',userId:'owner',projectId:'p',input:{operationId:'operation-one',connectionId:'client-one'},items:[{id:'one',status:'pending'}]});
 const completed=await until(()=>{const current=jobs.getJob('owner',created.id);return current.status==='completed'&&current});
 assert.equal(completed.result.versionId,'version-one');assert.equal(completed.result.succeeded,1);assert.equal(completed.canRetry,false);
 assert.equal(jobs.getManagedJob('owner','client-one',created.id).id,created.id);
 assert.equal(jobs.getManagedJob('owner','different',created.id),null);assert.equal(jobs.getManagedJob('other','client-one',created.id),null);
 assert.equal(jobs.retryJob('owner',created.id),null);
});
test('connection cancellation aborts its own active work and never leaks raw errors',async()=>{
 let entered;
 const started=new Promise(r=>entered=r);
 jobs.registerManagedJob('mcp_inference',async ctx=>{entered();await new Promise(resolve=>ctx.signal.addEventListener('abort',resolve,{once:true}));throw Error('secret /private/model/path')});
 const created=jobs.createManagedJob({type:'mcp_inference',name:'Draft inference',userId:'owner',projectId:'p',input:{operationId:'operation-two',connectionId:'client-two'},items:[{id:'two',status:'pending'}]});
 await started;
 assert.equal(jobs.cancelConnectionJobs('owner','other-client'),0);assert.equal(jobs.cancelConnectionJobs('owner','client-two'),1);
 const canceled=await until(()=>{const current=jobs.getJob('owner',created.id);return current.status==='canceled'&&current});
 assert.ok(!JSON.stringify(canceled).includes('/private/'));
});
