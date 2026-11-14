'use strict';
const express = require('express');
const {McpServer,fromJsonSchema,createMcpHandler}=require('@modelcontextprotocol/server');
const {toNodeHandler}=require('@modelcontextprotocol/node');
const {SCOPES}=require('./mcp-permissions');
const {digest}=require('./mcp-source-state');
const {actionError}=require('./mcp-action-errors');
const MAX_BODY=32*1024;
function createRemoteMcpRouter({config,oauth,policy,queries}) {
  const router=express.Router();
  const expectedHost=new URL(config.origin).host;
  const origins=new Set([config.origin,...(config.allowedOrigins||[])]);
  const rates=new Map();
  function consume(key,limit) {
    const now=Date.now();
    for(const [id,row] of rates)if(row.expires<=now)rates.delete(id);
    if(!rates.has(key)&&rates.size>=10000)return false;
    const row=rates.get(key)||{count:0,expires:now+60000};
    row.count++;rates.set(key,row);return row.count<=limit;
  }
  router.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
    if(String(req.headers.host||'').toLowerCase()!==expectedHost.toLowerCase())return res.status(400).json({error:'invalid_host'});
    if(req.headers.origin&&!origins.has(req.headers.origin))return res.status(403).json({error:'invalid_origin'});
    if(req.headers.origin) {
      res.set({'Access-Control-Allow-Origin':req.headers.origin,'Vary':'Origin',
        'Access-Control-Expose-Headers':'WWW-Authenticate, MCP-Protocol-Version',
        'Access-Control-Allow-Headers':'Authorization, Content-Type, MCP-Protocol-Version, MCP-Method, MCP-Name, MCP-Session-Id, Last-Event-ID',
        'Access-Control-Allow-Methods':'GET, POST, OPTIONS'});
    }
    if(req.method==='OPTIONS')return res.sendStatus(204);
    if(!consume('ip:'+req.ip,240))return res.status(429).set('Retry-After','60').json({error:'rate_limited'});
    next();
  });
  const metadata={resource:config.resource,authorization_servers:[config.issuer],scopes_supported:SCOPES,
    bearer_methods_supported:['header'],resource_name:'LibreFlow Annotate'};
  router.get(['/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource'],(req,res)=>res.json(metadata));
  // RFC 8414 path-based issuer discovery. oidc-provider owns protocol fields.
  router.get('/.well-known/oauth-authorization-server/oauth',(req,res,next)=>{
    req.url='/.well-known/oauth-authorization-server';
    req.originalUrl='/oauth'+req.url;req.baseUrl='/oauth';
    oauth.provider.callback()(req,res,next);
  });
  router.use('/oauth',oauth.provider.callback());
  async function authenticate(req,res,next) {
    if(req.headers.cookie)return res.status(403).json({error:'cookies_not_accepted'});
    if(req.url.includes('?'))return res.status(400).json({error:'query_not_accepted'});
    const match=/^Bearer ([^\s]+)$/.exec(req.get('authorization')||'');
    try {
      const principal=match&&await oauth.authenticateToken(match[1]);
      if(!principal) {
        res.set('WWW-Authenticate','Bearer resource_metadata="'+config.origin+'/.well-known/oauth-protected-resource/mcp"');
        return res.status(401).json({error:'invalid_token'});
      }
      if(!consume('connection:'+principal.connectionId,60)||!consume('user:'+principal.userId,120))
        return res.status(429).set('Retry-After','60').json({error:'rate_limited'});
      req.auth={token:match[1],clientId:principal.clientId,scopes:principal.grantedScopes,
        expiresAt:Math.floor(Date.parse(principal.expiresAt)/1000),resource:new URL(config.resource),extra:{principal}};
      next();
    }catch {res.status(503).json({error:'authorization_unavailable'});}
  }
  router.get('/mcp-downloads/:projectId/:exportId',authenticate,(req,res)=>require('./mcp-downloads').sendExportDownload(req,res,req.auth.extra.principal,{reauthenticate:async()=>{const fresh=await oauth.authenticateToken(req.auth.token);return fresh&&digest(fresh)===digest(req.auth.extra.principal);}}));
  const handler=createMcpHandler(async ({authInfo})=>{
    const principal=authInfo?.extra?.principal;
    if(!principal)throw new Error('Authentication required');
    const server=new McpServer({name:'libreflow-mcp',version:'1.0.0'},{capabilities:{tools:{}}});
    for(const tool of await queries.listTools(principal)) {
      server.registerTool(tool.name,{title:tool.title,description:tool.description,
        inputSchema:fromJsonSchema(tool.inputSchema),outputSchema:fromJsonSchema(tool.outputSchema),
        annotations:{readOnlyHint:!tool.action,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
        async args=>{
          try {
            const fresh=await oauth.authenticateToken(authInfo.token);
            if(!fresh||digest(fresh)!==digest(principal))throw Object.assign(new Error(),{status:401});
            const result=await queries.callTool(fresh,tool.name,args||{});
            const after=await oauth.authenticateToken(authInfo.token);
            if(!after||digest(after)!==digest(fresh))throw Object.assign(new Error(),{status:401});
            if(!policy.recordActivity(after,{tool:tool.name,outcome:'ok',...(args?.projectId?{projectId:args.projectId}:{})}))throw new Error();
            const serialized=JSON.stringify(result);
            const content=[{type:'text',text:serialized.length<=1024?serialized:'Tool completed. See the structured result.'}];
            if(tool.name==='libreflow_get_image_preview') {
              content[0].text='Image preview in original-image coordinates; use the supplied transform.';
              content.push({type:'image',mimeType:result.image.mimeType,data:result.image.data});
            }
            return {content,structuredContent:result};
          } catch(error) {
            try{policy.recordActivity(principal,{tool:tool.name,outcome:'error'});}catch{}
            const safe=actionError(error);
            return {isError:true,content:[{type:'text',text:JSON.stringify(safe?{code:safe.code,message:safe.message}:
              {code:error.status===401?'UNAUTHORIZED':'REQUEST_FAILED',message:error.status===401?'This connection is expired or revoked.':'Unable to complete the request. Check permissions and settings.'})}]};
          }
        });
    }
    return server;
  },{legacy:'stateless',maxRequestBodySize:MAX_BODY,onerror:()=>{}});
  const handle=toNodeHandler(handler,{maxRequestBodySize:MAX_BODY,onerror:()=>{}});
  router.all('/mcp',authenticate,(req,res)=>handle(req,res).catch(()=>{if(!res.headersSent)res.status(500).json({error:'protocol_error'});else res.destroy();}));
  router.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(400).json({error:'invalid_request'});});
  return router;
}
module.exports={createRemoteMcpRouter};
