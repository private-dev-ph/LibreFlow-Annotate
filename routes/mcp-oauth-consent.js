'use strict';
const express=require('express');
const path=require('node:path');
const {scopeMetadata,writesEnabled}=require('../lib/mcp-permissions');
const {dataFile,readJson}=require('../lib/json-store');
const {isProjectMember}=require('../lib/access-control');
function createOAuthConsentRouter({oauth,config,policy}) {
 const router=express.Router();
 const validUid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
 router.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  if(req.get('authorization'))return res.status(401).json({message:'Use a browser session to review access.'});
  if(req.get('host')!==new URL(config.origin).host)return res.status(400).json({message:'Use the configured LibreFlow address to review this connection.'});
  next();
 });
 async function details(req,res){
  if(!validUid(req.params.uid))throw new Error('Invalid interaction');
  const value=await oauth.interactionDetails(req,res);
  if(value.uid!==req.params.uid)throw new Error('Interaction mismatch');
  return value;
 }
 function requireUser(req,res,next){
  if(!req.session?.userId||!policy.userExists(req.session.userId))return res.status(401).json({message:'Sign in to review this connection.'});
  next();
 }
 router.get('/:uid',async(req,res)=>{
  if(!validUid(req.params.uid))return res.sendStatus(404);
  if(!req.session?.userId||!policy.userExists(req.session.userId))
   return res.redirect('/login?returnTo='+encodeURIComponent('/ai-authorize/'+req.params.uid));
  try{await details(req,res);res.sendFile(path.join(__dirname,'../public/ai-authorize.html'));}
  catch{res.status(400).send('This connection request expired or is invalid. Restart the connection from your AI client.');}
 });
 router.get('/:uid/details',requireUser,async(req,res)=>{
  try{
   const interaction=await details(req,res);
   const client=await oauth.provider.Client.find(interaction.params.client_id);
   const requested=String(interaction.params.scope||'').split(/\s+/);
   if(!requested.includes('mcp:projects:read'))return res.status(400).json({message:'The client must request project access to connect to LibreFlow.'});
   res.json({client:{name:client?.clientName||client?.clientId||'AI client'},user:{username:req.session.username||'Signed-in user'},
    projects:readJson(dataFile('projects.json'),[]).filter(p=>isProjectMember(p,req.session.userId)).map(p=>({id:p.id,name:p.name})),
    scopes:scopeMetadata().filter(s=>requested.includes(s.id)),expiresInDays:30,loginStep:interaction.prompt?.name==='login',writesEnabled:writesEnabled()});
  }catch{res.status(400).json({message:'This request expired or is invalid. Restart the connection from your AI client.'});}
 });
 router.post('/:uid/approve',requireUser,async(req,res)=>{
  try{
   await details(req,res);
   if(!req.body||Object.keys(req.body).some(key=>!['projectIds','scopes','expiresInDays'].includes(key)))return res.status(400).json({message:'Check the selected projects and permissions.'});
   if(!writesEnabled()&&(req.body.scopes||[]).some(scope=>scopeMetadata().find(s=>s.id===scope)?.action))
    return res.status(400).json({message:'AI actions are disabled on this server.'});
   const result=await oauth.approveInteraction(req,res,{...req.body,userId:req.session.userId,returnRedirect:true});
   return res.json({redirectTo:result.redirectTo});
  }catch{res.status(400).json({message:'Access could not be approved. Check the selected projects and dependent permissions, or restart an expired connection request.'});}
 });
 router.post('/:uid/deny',requireUser,async(req,res)=>{
  try{await details(req,res);const result=await oauth.denyInteraction(req,res,{returnRedirect:true});res.json({redirectTo:result.redirectTo});}
  catch{res.status(400).json({message:'This connection request is no longer active.'});}
 });
 return router;
}
module.exports={createOAuthConsentRouter};
