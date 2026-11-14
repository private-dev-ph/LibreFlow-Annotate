'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const {dataFile,readJson,writeJson}=require('./json-store');
const {modelsDir}=require('./data-store');
const {readJsonByKey}=require('./read-index');
const policy=require('./mcp-connections');
const ops=require('./mcp-operations');
const state=require('./mcp-source-state');
const jobs=require('./job-runner');
const context=require('./mcp-job-context');
const {safeStoredPath,inferImage,modelAccessibleToUser}=require('./inference-client');
const {normalizeClassIds}=require('./inference-classes');
const Tiling=require('../public/js/inference-tiling-settings');
const {LIMITS}=context;
const draftsFile=()=>dataFile('mcp-inference-drafts.json');
function shapesModule(){return require('./annotation-commands');}
function modelState(principal,projectId,modelId) {
  policy.requireProject(principal,projectId);
  const model=readJsonByKey(dataFile('models.json'),'id',modelId).find(m=>m.projectId===projectId);
  if(!model||!modelAccessibleToUser(model,principal.userId,projectId))throw ops.fail(404,'NOT_FOUND','Model not found.');
  if(model.type&&model.type!=='detection')throw ops.fail(400,'INVALID_ARGUMENT','AI draft inference requires a detection model.');
  const files=[model.filename,model.yamlFilename].filter(Boolean).map(filename=>{
    const stat=fs.statSync(safeStoredPath(modelsDir(),filename));
    return {filename,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
  });
  return {model,revision:state.digest({model,files})};
}
function ratio(value,fallback,name) {
  const result=value===undefined?fallback:value;
  if(typeof result!=='number'||!Number.isFinite(result)||result<0||result>1)throw ops.fail(400,'INVALID_ARGUMENT',name+' must be between 0 and 1.');
  return result;
}
function previewInference(principal,args) {
  ops.assertAuthority(principal,args.projectId,'inference.run');
  if(!Array.isArray(args.imageIds)||!args.imageIds.length||args.imageIds.length>LIMITS.images||new Set(args.imageIds).size!==args.imageIds.length)
    throw ops.fail(400,'INVALID_ARGUMENT','Select 1 to '+LIMITS.images+' distinct images.');
  const selectedModel=modelState(principal,args.projectId,args.modelId);
  let classIds,tiling;
  try {classIds=normalizeClassIds(args.classIds);tiling=Tiling.normalize(args.tiling);}
  catch {throw ops.fail(400,'INVALID_ARGUMENT','Check class IDs and tiling settings.');}
  const confThreshold=ratio(args.confThreshold,.25,'Confidence');
  if(confThreshold<.01)throw ops.fail(400,'INVALID_ARGUMENT','Confidence must be at least 0.01.');
  const images=args.imageIds.map(id=>state.frozenImage(args.projectId,id));
  let pixels=0,tiles=0;
  for(const item of images){
    const image=state.imageState(args.projectId,item.imageId).image;
    if(!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||image.width<1||image.height<1)
      throw ops.fail(400,'INVALID_ARGUMENT','Image dimensions must be available before inference.');
    pixels+=image.width*image.height;tiles+=Tiling.tileCount(image.width,image.height,tiling);
  }
  if(pixels>LIMITS.totalPixels||tiles>LIMITS.tiles)throw ops.fail(413,'LIMIT_EXCEEDED','Use fewer images or larger tile strides.');
  const payload={images,modelId:args.modelId,modelRevision:selectedModel.revision,confThreshold,classIds,tiling};
  const details=[{label:'Model',value:String(selectedModel.model.name||'Detection model')},
    {label:'Classes',value:classIds===null?'All classes':classIds.join(', ')},
    {label:'Confidence',value:String(confThreshold)},
    {label:'Tiling',value:tiling.enabled?JSON.stringify(tiling):'Off'}];
  return ops.createProposal(principal,{kind:'inference.run',projectId:args.projectId,requestKey:args.requestKey,payload,
    summary:{title:'Generate annotation drafts',description:'Run inference on the selected images. Existing annotations and review states stay unchanged.',
      warnings:['Saving any draft requires a separate annotation approval.'],counts:{images:images.length,pixels,tiles},details}});
}
function startInference(principal,args) {
  return context.queueApproved(principal,args,'inference.run','mcp_inference','Generate AI annotation drafts',record=>{
    state.assertFrozenImages(args.projectId,record.payload.images);
    if(modelState(principal,args.projectId,record.payload.modelId).revision!==record.payload.modelRevision)throw state.conflict('The model changed. Create a new preview.');
    return record.payload.images.map(image=>({id:crypto.randomUUID(),imageId:image.imageId,status:'pending'}));
  });
}
function storedDrafts() {
  const all=readJson(draftsFile(),[]);
  if(!Array.isArray(all))throw ops.fail(503,'SECURITY_STATE_UNAVAILABLE','Inference drafts are unavailable.');
  return all;
}
function draftFor(principal,projectId,draftId) {
  const draft=storedDrafts().find(d=>d.id===draftId&&d.projectId===projectId);
  if(!draft||Date.parse(draft.expiresAt)<=Date.now())throw ops.fail(404,'NOT_FOUND','Inference draft not found or expired.');
  context.ownedJob(principal,projectId,draft.jobId);
  if(!principal.grantedScopes.includes('mcp:annotations:read'))throw ops.fail(403,'SCOPE_REQUIRED','Annotation access is required.');
  return draft;
}
function getDraft(principal,{projectId,draftId,offset=0,limit=100}) {
  const draft=draftFor(principal,projectId,draftId);
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw ops.fail(400,'INVALID_ARGUMENT','Invalid draft page.');
  return {draftId,projectId,imageId:draft.imageId,expectedStateRevision:draft.frozen.revision,
    items:draft.shapes.slice(offset,offset+limit),total:draft.shapes.length,
    nextOffset:offset+limit<draft.shapes.length?offset+limit:null,expiresAt:draft.expiresAt};
}
function cleanupDrafts() {
  const all=storedDrafts(),keep=all.filter(d=>Date.parse(d.expiresAt)>Date.now());
  if(keep.length!==all.length)writeJson(draftsFile(),keep);
}
function registerInferenceJobs({infer=inferImage}={}) {
  jobs.registerManagedJob('mcp_inference',async ({getJob,signal,markItem})=>{
    const runSignal=context.jobDeadline(signal);
    let job=getJob(),total=0;const draftIds=[];
    for(const item of job.items) {
      const principal=context.checkRunning(getJob,runSignal);job=getJob();
      const payload=job.input.payload;
      const frozen=payload.images.find(i=>i.imageId===item.imageId);
      state.assertFrozenImages(job.projectId,[frozen]);
      if(modelState(principal,job.projectId,payload.modelId).revision!==payload.modelRevision)throw state.conflict('The model changed.');
      const previous=storedDrafts().find(d=>d.jobId===job.id&&d.imageId===item.imageId&&Date.parse(d.expiresAt)>Date.now());
      if(previous){draftIds.push(previous.id);total+=previous.shapes.length;markItem(item.id,{status:'succeeded',annotationCount:previous.shapes.length});continue;}
      markItem(item.id,{status:'processing'});
      const response=await infer({userId:principal.userId,projectId:job.projectId,modelId:payload.modelId,imageId:item.imageId,
        confThreshold:payload.confThreshold,classIds:payload.classIds,tiling:payload.tiling,signal:runSignal,maxResponseBytes:8*1024*1024});
      context.checkRunning(getJob,runSignal);
      if(!Array.isArray(response.results)||response.results.length>5000||total+response.results.length>LIMITS.detections)
        throw ops.fail(413,'LIMIT_EXCEEDED','Inference returned too many detections.');
      const current=state.imageState(job.projectId,item.imageId);
      const shapes=response.results.map(s=>({label:s.label,type:s.type,data:s.data,
        ...(s.confidence!==undefined||s.conf!==undefined?{confidence:s.confidence??s.conf}:{})}));
      shapesModule().validateAdditions({shapes,image:current.image,project:current.project});
      const createdAt=new Date().toISOString();
      const draft={id:crypto.randomUUID(),jobId:job.id,connectionId:principal.connectionId,projectId:job.projectId,
        imageId:item.imageId,modelId:payload.modelId,frozen,shapes,createdAt,expiresAt:new Date(Date.now()+LIMITS.draftDays*86400000).toISOString()};
      context.commitJob(getJob,runSignal,()=>{
        state.assertFrozenImages(job.projectId,[frozen]);
        if(modelState(principal,job.projectId,payload.modelId).revision!==payload.modelRevision)throw state.conflict();
        const all=storedDrafts().filter(d=>Date.parse(d.expiresAt)>Date.now());all.push(draft);
        if(Buffer.byteLength(JSON.stringify(all))>64*1024*1024)throw ops.fail(413,'LIMIT_EXCEEDED','Inference draft storage is full.');
        writeJson(draftsFile(),all);
        markItem(item.id,{status:'succeeded',annotationCount:shapes.length,completedAt:createdAt});
      });
      draftIds.push(draft.id);total+=shapes.length;
    }
    return {draftIds,annotationCount:total,requiresAnnotationApproval:true};
  });
}
function proposeAnnotations(principal,args) {
  ops.assertAuthority(principal,args.projectId,'annotations.append');
  let imageId=args.imageId,shapes=args.shapes,expected=args.expectedStateRevision,modelId=null,frozen;
  if(args.draftId){
    if(args.imageId!==undefined||args.shapes!==undefined||args.expectedStateRevision!==undefined)throw ops.fail(400,'INVALID_ARGUMENT','Choose a draft or manual additions, not both.');
    const draft=draftFor(principal,args.projectId,args.draftId);
    ({imageId,shapes,modelId,frozen}=draft);expected=frozen.revision;
  }
  const current=state.imageState(args.projectId,imageId);
  if(current.revision!==expected)throw state.conflict();
  if(frozen)state.assertFrozenImages(args.projectId,[frozen]);
  shapesModule().validateAdditions({shapes,image:current.image,project:current.project});
  const payload={imageId,shapes,expectedStateRevision:expected,modelId,frozen:frozen||state.frozenImage(args.projectId,imageId)};
  return ops.createProposal(principal,{kind:'annotations.append',projectId:args.projectId,requestKey:args.requestKey,payload,
    summary:{title:'Add annotations',description:'Add the proposed shapes while preserving every existing annotation.',
      warnings:shapes.length?['This image becomes in progress and is no longer marked null.']:['No shapes will be added; review and null state stay unchanged.'],
      counts:{images:1,existingAnnotations:current.annotations.length,addedAnnotations:shapes.length},
      details:[{label:'Image',value:String(current.image.originalName||imageId)},{label:'Labels',value:[...new Set(shapes.map(s=>s.label))].join(', ')}]}});
}
function applyAnnotations(principal,args) {
  return ops.consumeApproved(principal,args.projectId,args.operationId,'annotations.append',record=>{
    state.assertFrozenImages(args.projectId,[record.payload.frozen]);
    const user=readJsonByKey(dataFile('users.json'),'id',principal.userId)[0];
    return shapesModule().appendAnnotations({projectId:args.projectId,...record.payload,actorId:principal.userId,
      actorUsername:user?.username||'AI connection',connectionId:principal.connectionId,operationId:record.id});
  });
}
module.exports={previewInference,startInference,registerInferenceJobs,getDraft,proposeAnnotations,applyAnnotations,cleanupDrafts};
