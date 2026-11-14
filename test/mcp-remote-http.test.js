'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {once}=require('node:events');
const {Client,StreamableHTTPClientTransport}=require('@modelcontextprotocol/client');
const {createRemoteMcpRouter}=require('../lib/mcp-remote-http');
test('official modern and legacy HTTP clients use bearer identity without browser authority', {timeout:30000}, async t=>{
 const app=express();let router,revoked=false;
 app.use((req,res,next)=>router(req,res,next));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const origin='http://127.0.0.1:'+server.address().port;
 const principal={userId:'u',clientId:'c',connectionId:'k',grantedScopes:['mcp:projects:read'],allowedProjectIds:['p'],expiresAt:new Date(Date.now()+60000).toISOString()};
 const schema={type:'object',additionalProperties:false,properties:{}};
 router=createRemoteMcpRouter({config:{origin,issuer:origin+'/oauth',resource:origin+'/mcp'},oauth:{
   authenticateToken:async token=>token==='isolated-test-token'&&!revoked?principal:null,
   provider:{callback:()=>((_req,res)=>res.json({issuer:origin+'/oauth'}))}
 },policy:{recordActivity:()=>({ok:true})},queries:{
   listTools:async()=>[{name:'test_read',title:'Read',description:'Read fixture',inputSchema:schema,outputSchema:{type:'object',additionalProperties:false,required:['project'],properties:{project:{type:'string'}}}}],
   callTool:async()=>({project:'p'})
 }});
 const metadata=await fetch(origin+'/.well-known/oauth-protected-resource/mcp');assert.equal(metadata.status,200);assert.equal((await metadata.json()).resource,origin+'/mcp');
 const missing=await fetch(origin+'/mcp',{method:'POST'});assert.equal(missing.status,401);assert.match(missing.headers.get('www-authenticate'),/resource_metadata/);
 for(const headers of [{Cookie:'libreflow.sid=not-authority'},{Origin:'https://attacker.invalid'}]){
   const response=await fetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer isolated-test-token',...headers}});assert.ok([400,403].includes(response.status), JSON.stringify(headers) + " status=" + response.status);
 }
 const badHost=await new Promise((resolve,reject)=>{const req=require('node:http').request(origin+'/mcp',{method:'POST',headers:{Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(badHost,400);
 for(const mode of ['legacy',{pin:'2026-07-28'}]){
   const client=new Client({name:'remote-test',version:'1'},{versionNegotiation:{mode}});
   const transport=new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Authorization:'Bearer isolated-test-token'}}});
   await client.connect(transport);try {
     const tools=await client.listTools();assert.equal(tools.tools[0].name,'test_read');
     const result=await client.callTool({name:'test_read',arguments:{}});assert.deepEqual(result.structuredContent,{project:'p'});
   }finally{await client.close();}
 }
 const tooLarge=await fetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer isolated-test-token','Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({padding:'a'.repeat(40000)})});
 assert.equal(tooLarge.status,413);
 revoked=true;assert.equal((await fetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer isolated-test-token'}})).status,401);
});


