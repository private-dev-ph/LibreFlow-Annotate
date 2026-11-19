
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-ai-requests-'));
process.env.LIBREFLOW_DATA_DIR = root;
process.env.LIBREFLOW_MCP_WRITES_ENABLED = 'true';
const {dataFile,writeJson,readJson}=require('../../lib/json-store');
const policy=require('../../lib/mcp-connections'), ops=require('../../lib/mcp-operations');
const put=(name,value)=>writeJson(dataFile(name+'.json'),value);
const scopes=['mcp:projects:read','mcp:annotations:read','mcp:annotations:append'];
function connection(){const created=policy.createConnection('owner',{name:'Test client',projectIds:['p'],scopes});return policy.authenticateConnection(created.token);}
function proposal(principal,key='unique',payload={imageId:'i',shapes:[]}){return ops.createProposal(principal,{kind:'annotations.append',projectId:'p',requestKey:key,payload,summary:{title:'Add annotations',description:'Existing annotations are preserved.',counts:{added:0},details:[],warnings:[]}});}
test.beforeEach(()=>{put('users',[{id:'owner'},{id:'other'}]);put('projects',[{id:'p',userId:'owner'},{id:'q',userId:'other'}]);put('mcp-connections',[]);put('mcp-operations',[]);process.env.LIBREFLOW_MCP_WRITES_ENABLED='true';});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('only the browser owner can approve the exact stored digest',()=>{
 const p=connection(), request=proposal(p);
 assert.throws(()=>ops.approveProposal('other',request.id,request.digest),e=>e.status===404);
 assert.throws(()=>ops.approveProposal('owner',request.id,'changed'),e=>e.code==='PREVIEW_CHANGED');
 assert.throws(()=>ops.consumeApproved(p,'p',request.id,'annotations.append',()=>({ok:true})),e=>e.code==='APPROVAL_REQUIRED');
 assert.equal(ops.approveProposal('owner',request.id,request.digest).status,'approved');
 let calls=0;const apply=()=>{calls++;put('effect',[{id:'one'}]);return {id:'result'};};
 assert.deepEqual(ops.consumeApproved(p,'p',request.id,'annotations.append',apply),{id:'result'});
 assert.deepEqual(ops.consumeApproved(p,'p',request.id,'annotations.append',apply),{id:'result'});
 assert.equal(calls,1);assert.equal(ops.listUserProposals('other').length,0);
});
test('idempotency rejects changed payload and isolates connections',()=>{
 const p=connection(),other=connection(),a=proposal(p);
 assert.equal(proposal(p).id,a.id);
 assert.throws(()=>proposal(p,'unique',{changed:true}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 assert.notEqual(proposal(other).id,a.id);
 assert.throws(()=>ops.getInternalProposal(other,'p',a.id),e=>e.status===404);
});
test('failed action rolls back both its metadata and consumption',()=>{
 const p=connection(),r=proposal(p);ops.approveProposal('owner',r.id,r.digest);
 put('effect',[]);
 assert.throws(()=>ops.consumeApproved(p,'p',r.id,'annotations.append',()=>{put('effect',[{id:'bad'}]);throw new Error('failure');}),/failure/);
 assert.deepEqual(readJson(dataFile('effect.json')),[]);
 assert.equal(ops.getUserProposal('owner',r.id).status,'approved');
});
test('revocation and disabling actions invalidate prior approvals',()=>{
 const p=connection(),r=proposal(p);ops.approveProposal('owner',r.id,r.digest);
 process.env.LIBREFLOW_MCP_WRITES_ENABLED='false';
 assert.throws(()=>ops.consumeApproved(p,'p',r.id,'annotations.append',()=>({})),e=>e.code==='WRITES_DISABLED');
 process.env.LIBREFLOW_MCP_WRITES_ENABLED='true';policy.revokeConnection('owner',p.connectionId);
 assert.throws(()=>ops.consumeApproved(p,'p',r.id,'annotations.append',()=>({})),e=>e.status===401);
});
test('narrowed OAuth-style principal cannot use actions lacking read dependencies',()=>{
 const p=connection();p.grantedScopes=p.grantedScopes.filter(s=>s!=='mcp:annotations:read');
 assert.throws(()=>proposal(p),e=>e.code==='SCOPE_REQUIRED');
});
test('rejected, expired and corrupted requests cannot execute',()=>{
 const p=connection(),r=proposal(p);ops.rejectProposal('owner',r.id,r.digest);
 assert.throws(()=>ops.consumeApproved(p,'p',r.id,'annotations.append',()=>({})),e=>e.code==='APPROVAL_REQUIRED');
 const second=proposal(p,'second');const originalNow=Date.now;
 try{Date.now=()=>originalNow()+ops.TTL_MS+1;assert.throws(()=>ops.approveProposal('owner',second.id,second.digest),e=>e.code==='NOT_PENDING');}finally{Date.now=originalNow;}
 const records=readJson(dataFile('mcp-operations.json'));records[1].payload={unapproved:'change'};put('mcp-operations',records);
 assert.throws(()=>ops.getUserProposal('owner',second.id),e=>e.code==='SECURITY_STATE_UNAVAILABLE');
});
test('the live project access check also sees staged membership removals',()=>{
 const {runDataCommand}=require('../../lib/data-command');const p=connection(),r=proposal(p);
 assert.equal(policy.requireProject(p,'p').id,'p');
 runDataCommand(()=>{put('projects',[]);assert.throws(()=>ops.approveProposal('owner',r.id,r.digest));});
});

