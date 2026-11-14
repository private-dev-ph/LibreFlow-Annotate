'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'libreflow-mcp-grants-'));
process.env.LIBREFLOW_DATA_DIR=root;
const {dataFile,writeJson,readJson}=require('../lib/json-store');
const policy=require('../lib/mcp-connections');
const {imageState}=require('../lib/mcp-source-state');
const put=(name,value)=>writeJson(dataFile(name+'.json'),value);
test.before(()=>{put('users',[{id:'owner'},{id:'other'}]);put('projects',[{id:'p',userId:'owner',labelClasses:['Part']}]);put('images',[{id:'i',projectId:'p',filename:'board.png',width:100,height:100}]);put('annotations',[]);});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('action grants require explicit dependent permissions without widening old grants',()=>{
 assert.throws(()=>policy.createConnection('owner',{name:'Incomplete',projectIds:['p'],scopes:['mcp:projects:read','mcp:inference:run']}),e=>e.code==='DEPENDENT_SCOPE_REQUIRED');
 const local=policy.createConnection('owner',{name:'Read only',projectIds:['p'],scopes:['mcp:projects:read']});
 assert.deepEqual(policy.authenticateConnection(local.token).grantedScopes,['mcp:projects:read']);
});
test('OAuth identities stay bound to issuer, account, client and grant with immediate revocation',()=>{
 const identity={userId:'owner',clientId:'client-one',grantId:'grant-one',issuer:'https://example.test/oauth',scopes:['mcp:projects:read','mcp:annotations:read']};
 const created=policy.createOAuthConnection('owner',{name:'Remote client',projectIds:['p'],expiresInDays:7,...Object.fromEntries(Object.entries(identity).filter(([key])=>key!=='userId'))});
 assert.equal(created.token,undefined);
 const stored=readJson(dataFile('mcp-connections.json'),[]).find(r=>r.id===created.connection.id);
 assert.equal(stored.tokenHash,undefined);assert.equal(stored.purpose,'mcp-oauth-v1');
 const principal=policy.authenticateOAuthConnection(identity);assert.ok(principal);assert.equal(principal.connectionId,created.connection.id);
 assert.equal(policy.requireProject(principal,'p').id,'p');
 const narrower=policy.authenticateOAuthConnection({...identity,scopes:['mcp:projects:read']});assert.deepEqual(narrower.grantedScopes,['mcp:projects:read']);assert.equal(policy.requireProject(narrower,'p').id,'p');
 for(const [key,value] of [['issuer','https://attacker.test/oauth'],['clientId','another'],['grantId','another'],['userId','other']])assert.equal(policy.authenticateOAuthConnection({...identity,[key]:value}),null,key);
 assert.equal(policy.authenticateOAuthConnection({...identity,scopes:['mcp:annotations:read']}),null);
 policy.revokeConnection('owner',created.connection.id);assert.equal(policy.authenticateOAuthConnection(identity),null);assert.throws(()=>policy.requireProject(principal,'p'));
});
test('state revisions detect annotation, null, review and label changes without creating history',()=>{
 const original=imageState('p','i').revision;
 put('annotations',[{id:'a',imageId:'i',label:'Part',type:'bbox',data:{x:1,y:2,width:3,height:4}}]);
 const annotated=imageState('p','i').revision;assert.notEqual(annotated,original);
 put('images',[{id:'i',projectId:'p',filename:'board.png',width:100,height:100,isNull:true}]);
 const nulled=imageState('p','i').revision;assert.notEqual(nulled,annotated);
 put('reviews',[{imageId:'i',status:'approved'}]);assert.notEqual(imageState('p','i').revision,nulled);
 assert.equal(fs.existsSync(dataFile('annotation-revisions.json')),false);
});
