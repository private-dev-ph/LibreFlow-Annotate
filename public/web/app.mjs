import { Workspace, importPortable } from './workspace.mjs';
import { sha256 } from './crypto.mjs';
import { WebAPI } from './api.mjs';
import { configuration } from './config.mjs';
import { createFileSystemProvider, createMemoryProvider } from './providers/local.mjs';
import { createGoogleDriveProvider } from './providers/google-drive.mjs';
import { createGraphOneDriveProvider } from './providers/graph-onedrive.mjs';
import { createDropboxProvider } from './providers/dropbox.mjs';
import { createInferenceCompanion } from './inference.mjs';
const $=id=>document.getElementById(id);
let provider, workspace, api, projectId, imageId, imageUrl, companion, abortInference, dirty=false, draftWrites=Promise.resolve();
const status=message=>{$('status').textContent=message;};
const describe=()=>{if(workspace)status(`${workspace.status.state} · ${workspace.status.pending} pending · last sync ${workspace.status.lastSync||'not yet'}`);};
function option(select,value,text){const node=document.createElement('option');node.value=value;node.textContent=text;select.append(node);}
async function run(task){try{await task();}catch(error){status(error.code==='auth_expired'?'Storage authorization expired or was revoked. Reauthorize and retry; encrypted pending edits remain cached.':error.message);if(error.code==='conflict')showConflict();}}
function showConflict(){if(!workspace||!imageId)return;const heads=workspace.heads('annotation',imageId);$('conflict').hidden=heads.length<2;$('conflict-revision').replaceChildren();heads.forEach(n=>option($('conflict-revision'),n.id,`${n.createdAt} · ${n.value.length} shapes`));}
function showShapes(shapes){$('shapes').replaceChildren();for(const shape of shapes){const node=document.createElement('li');node.textContent=`${shape.type}: ${shape.label}`;$('shapes').append(node);}}
// Canvas uses this existing callback rather than coupling geometry to storage.
globalThis.App={promptLabel(callback){const label=$('label').value.trim();if(label)callback(label);}};
async function initialize(){
  await workspace.recover();api=new WebAPI(workspace);globalThis.LibreFlowWeb={api,workspace};
  $('passphrase').value='';$('connect').hidden=true;$('workspace').hidden=false;
  Canvas.init($('canvas'),$('canvas-wrap'),shapes=>{showShapes(shapes);});
  const session=await api.restoreSession();await refreshProjects(session?.projectId);describe();const transfers=await workspace.pendingTransfers();if(transfers.length)status(`${transfers.length} interrupted transfer(s). Reselect the same files to retry; verified uploaded chunks will be reused.`);
}
async function refreshProjects(selected){$('projects').replaceChildren();const projects=await api.getProjects();projects.forEach(p=>option($('projects'),p.id,p.name));projectId=projects.some(p=>p.id===selected)?selected:projects[0]?.id;$('projects').value=projectId||'';await refreshImages();}
async function refreshImages(){imageId=null;dirty=false;$('image-list').replaceChildren();$('model-list').replaceChildren();if(!projectId)return;const images=await api.getImages(projectId);images.forEach(i=>option($('image-list'),i.id,i.originalName));(await api.getModels(projectId)).forEach(m=>option($('model-list'),m.id,m.name));if(images[0])await selectImage(images[0].id);}
async function selectImage(id){
 if(dirty)throw new Error('Save the current annotation edit before switching images');
 imageId=id;$('image-list').value=id;let shapes=await api.getAnnotations(id);const draft=await workspace.readDraft(id);if(draft){shapes=draft;dirty=true;}const blob=await api.imageBlob(id);if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=URL.createObjectURL(blob);Canvas.loadImage(imageUrl,shapes);
 await refreshHistory();await refreshReview();await api.saveSession({projectId,imageId:id});describe();
}
async function refreshHistory(){$('revisions').replaceChildren();for(const n of await api.getAnnotationRevisions(imageId))option($('revisions'),n.id,`${n.createdAt} · ${n.value.length} shapes`);}
async function refreshReview(){const review=await api.getImageReview(imageId);$('review').value=review.status;$('comments').replaceChildren();for(const note of review.comments){const n=document.createElement('li');n.textContent=note.message;$('comments').append(n);}}
async function selectStorage(){
 const type=$('provider').value;
 if(type==='local'){provider=createFileSystemProvider();await provider.connect();}
 else if(type==='fallback'){provider=createMemoryProvider();await provider.connect();status('Browser workspace is temporary. Export an encrypted backup before closing.');}
 else if(type==='s3'){if(!companion)throw new Error('Pair the local companion before connecting S3');const {createS3CompanionProvider}=await import('./providers/s3-companion.mjs');provider=createS3CompanionProvider({companion});await provider.connect();}
 else {
  const {authorizeProvider}=await import('./oauth-ui.mjs');const token=await authorizeProvider(type,configuration);provider=type==='google'?createGoogleDriveProvider():type==='onedrive'?createGraphOneDriveProvider():createDropboxProvider();await provider.connect({token});
 }
 provider.name ||= type;await provider.selectWorkspace(type==='local'||type==='fallback'?'root':$('folder').value.trim()||($('provider').value==='dropbox'?'':'root'));return provider;
}
const root=()=>$('folder').value.trim()||($('provider').value==='dropbox'?'':'root');
$('authorize').onclick=()=>run(async()=>{await selectStorage();status('Storage connected. Choose a workspace folder, then open or create it.');});
$('open').onclick=()=>run(async()=>{if(!provider)await selectStorage();workspace=await Workspace.connect(provider,root(),$('passphrase').value);await initialize();});
$('create').onclick=()=>run(async()=>{if(!provider)await selectStorage();workspace=await Workspace.create(provider,root(),$('passphrase').value);await initialize();});
$('provider').onchange=()=>run(async()=>{if(provider)await provider.disconnect();provider=null;$('provider-note').textContent=$('provider').value==='fallback'?'Temporary browser memory; use encrypted export/import for persistence.':$('provider').value==='local'?'Select a dedicated folder. Browsers without directory handles can use portable browser workspace.':'Authorization goes directly to your identity provider. This deployment must register a public OAuth client ID. Select a dedicated cloud folder; provider sharing controls access.';});
$('import').onchange=()=>run(async()=>{const file=$('import').files[0];if(!file)return;if(file.size>128*1024*1024)throw new Error('Portable backup exceeds the 128 MiB import limit');if(!provider)await selectStorage();workspace=await importPortable(provider,root(),JSON.parse(await file.text()),$('passphrase').value);await initialize();});
$('new-project').onclick=()=>run(async()=>{const name=$('project-name').value.trim();if(!name)throw new Error('Enter a project name');const p=await api.createProject(name);$('project-name').value='';await refreshProjects(p.id);describe();});
$('projects').onchange=()=>run(async()=>{if(dirty)throw new Error('Save edits before switching projects');projectId=$('projects').value;await refreshImages();});
$('images').onchange=()=>run(async()=>{if(!projectId)throw new Error('Create a project first');if(dirty)throw new Error('Save edits before adding images');await api.uploadImages(projectId,$('images').files,{onProgress:(done,total)=>{$('progress').hidden=false;$('progress').value=done/total*100;}});$('progress').hidden=true;await refreshImages();describe();});
$('image-list').onchange=()=>run(()=>selectImage($('image-list').value));
$('tool').onchange=()=>Canvas.setTool($('tool').value);
$('undo').onclick=()=>{Canvas.undo();dirty=true;};$('redo').onclick=()=>{Canvas.redo();dirty=true;};$('delete-shape').onclick=()=>{Canvas.deleteSelected();dirty=true;};
$('save').onclick=()=>run(async()=>{if(!imageId)throw new Error('Select an image');await draftWrites;await api.saveAnnotations(imageId,Canvas.getShapes());await workspace.clearDraft(imageId);dirty=false;await refreshHistory();describe();showConflict();});
$('restore').onclick=()=>run(async()=>{await api.restoreAnnotationRevision(imageId,$('revisions').value);dirty=false;await selectImage(imageId);describe();});
$('save-review').onclick=()=>run(async()=>{await api.updateImageReview(imageId,{status:$('review').value});describe();});
$('add-comment').onclick=()=>run(async()=>{const value=$('review-comment').value.trim();if(!value)return;await api.addReviewComment(imageId,value);$('review-comment').value='';await refreshReview();describe();});
$('retry').onclick=()=>run(async()=>{await workspace.sync();describe();showConflict();});
$('offline').onchange=()=>{workspace.offline=$('offline').checked;workspace.status.state=workspace.offline?'offline':'pending';describe();};
$('resolve').onclick=()=>run(async()=>{const n=workspace.nodes.get($('conflict-revision').value);if(!n)throw new Error('Choose a conflict revision');await workspace.put('annotation',imageId,n.value,{resolve:true});dirty=false;$('conflict').hidden=true;await selectImage(imageId);});
$('version').onclick=()=>run(async()=>{if(dirty)throw new Error('Save edits before creating a version');if(!projectId)throw new Error('Select a project');const v=await api.createVersion(projectId);status(`Created immutable dataset version ${v.id}`);});
$('export').onclick=()=>run(async()=>{if(dirty)throw new Error('Save edits before exporting');const backup=await workspace.exportPortable();const url=URL.createObjectURL(new Blob([JSON.stringify(backup)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='libreflow-encrypted-workspace.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('disconnect').onclick=()=>run(async()=>{if(dirty)throw new Error('Save edits before disconnecting');companion?.disconnect();await api.logout();if(imageUrl)URL.revokeObjectURL(imageUrl);workspace=api=provider=null;globalThis.LibreFlowWeb=null;location.reload();});
$('pair').onclick=()=>run(async()=>{companion=createInferenceCompanion();await companion.pair($('pair-code').value);$('pair-code').value='';const health=await companion.health();status(`Companion paired. ${JSON.stringify(health.capabilities||health)}`);});
$('model-file').onchange=()=>run(async()=>{const f=$('model-file').files[0];if(!f||!projectId)throw new Error('Select a project and ONNX model');await api.uploadModel(projectId,f);$('model-list').replaceChildren();(await api.getModels(projectId)).forEach(m=>option($('model-list'),m.id,m.name));describe();});
$('infer').onclick=()=>run(async()=>{if(!companion||!imageId)throw new Error('Pair the companion and select an image/model first');const model=workspace.get('model',$('model-list').value);if(!model)throw new Error('Select a model');abortInference=new AbortController();const chunks=[];for await(const chunk of workspace.readAsset(model.asset,{signal:abortInference.signal}))chunks.push(chunk);const m=await cachedObject(new Blob(chunks),'model','application/onnx',abortInference.signal);const i=await cachedObject(await api.imageBlob(imageId),'image','image/png',abortInference.signal);const result=await companion.infer(m.id,i.id,{signal:abortInference.signal});if(!Array.isArray(result.results))throw new Error('This ONNX model output is not supported for annotation decoding');Canvas.addShapes(result.results);status(result.message||`Inference completed: ${result.results.length} detections`);dirty=true;});
$('cancel-inference').onclick=()=>{abortInference?.abort();status('Inference cancellation requested');};
$('clear-cache').onclick=()=>run(async()=>{if(!companion)throw new Error('Pair the companion first');if(companion.clearCacheAll)await companion.clearCacheAll();else throw new Error('Restart the companion to clear all local cached objects');status('Companion caches cleared');});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
// External shape mutations from the reused canvas mark edits dirty.
const originalInit=Canvas.init.bind(Canvas);Canvas.init=(c,w,callback)=>originalInit(c,w,(shapes,selected,changed)=>{if(changed && imageId){dirty=true;const id=imageId,snapshot=structuredClone(shapes);draftWrites=draftWrites.then(()=>workspace.stageDraft(id,snapshot)).catch(e=>status(`Local recovery failed: ${e.message}`));status('Unsaved annotation edits · saving encrypted local recovery draft');}callback(shapes,selected,changed);});

run(async()=>{const {finishAuthorization}=await import('./oauth-ui.mjs');const result=await finishAuthorization(configuration);if(!result)return;$('provider').value=result.provider;provider=result.provider==='onedrive'?createGraphOneDriveProvider():createDropboxProvider();provider.name=result.provider;await provider.connect({token:result.token});status('Storage authorized. Select a workspace folder and enter your passphrase.');});

let linkedFiles=[];
$('list-folders').onclick=()=>run(async()=>{if(!provider)await selectStorage();const items=await provider.list(root());$('storage-folders').replaceChildren();option($('storage-folders'),root(),'Current folder');items.filter(f=>/folder|directory/.test(f.mimeType||'')).forEach(f=>option($('storage-folders'),f.id,f.name));status('Choose a storage folder before opening the workspace.');});
$('storage-folders').onchange=()=>{$('folder').value=$('storage-folders').value;};
$('create-folder').onclick=()=>run(async()=>{if(!provider)await selectStorage();const name=$('storage-folder-name').value.trim();if(!name)throw new Error('Enter a storage folder name');const folder=await provider.mkdir(root(),name);$('folder').value=folder.id;status('Storage folder created. Enter a passphrase, then create the workspace.');});
$('list-linked').onclick=()=>run(async()=>{linkedFiles=(await provider.list(workspace.root)).filter(f=>/^image\//.test(f.mimeType||''));$('linked-files').replaceChildren();linkedFiles.forEach(f=>option($('linked-files'),f.id,f.name));status('Linked assets remain unencrypted in their original provider location.');});
$('link-image').onclick=()=>run(async()=>{if(dirty)throw new Error('Save edits before switching images');const ref=linkedFiles.find(f=>f.id===$('linked-files').value);if(!ref)throw new Error('Select a provider image');await api.linkImage(projectId,ref);await refreshImages();describe();});

if('serviceWorker' in navigator)navigator.serviceWorker.register('./service-worker.js').catch(()=>{ /* Offline asset caching is optional; workspace recovery remains available. */ });

$('reauthorize').onclick=()=>run(async()=>{if(!['google','onedrive','dropbox'].includes($('provider').value))throw new Error('Reconnect local storage or the paired companion for this provider');await draftWrites;const {authorizeProvider}=await import('./oauth-ui.mjs');const token=await authorizeProvider($('provider').value,configuration);await provider.connect({token});await workspace.sync();describe();});

async function cachedObject(blob,kind,contentType,signal){const digest=await sha256(await blob.arrayBuffer());try{const existing=await companion.cacheExists(digest,{signal});if(existing.sha256!==digest||existing.kind!==kind)throw new Error('Companion cache identity mismatch');return existing;}catch(error){if(error.status!==404)throw error;}const ref=await companion.register(blob,kind,contentType,{signal});if(ref.sha256!==digest)throw new Error('Companion object checksum mismatch');return ref;}
