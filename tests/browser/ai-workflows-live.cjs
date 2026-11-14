'use strict';
// Runs only against the disposable Docker acceptance app, never port 6767.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const sharp=require('sharp');
const origin='http://127.0.0.1:6774', gateway='http://127.0.0.1:6775';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
 const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const request=context.request;
 async function post(url,data){const r=await request.post(origin+url,{headers:{Origin:origin},data});assert.ok(r.ok(),url+' HTTP '+r.status());return r.json();}
 const suffix=Date.now().toString(36);
 await post('/api/auth/register',{username:'QA '+suffix,email:'qa-'+suffix+'@example.test',password:'IsolatedTest8!'});
 const project=await post('/api/projects',{name:'AI workflow acceptance '+suffix,labelClasses:[{name:'A',color:'#48a868'},{name:'B',color:'#ef8750'}]});
 const raster=await sharp({create:{width:400,height:240,channels:3,background:'#284358'}}).png().toBuffer();
 const uploaded=await request.post(origin+'/api/images/upload',{headers:{Origin:origin},multipart:{projectId:project.id,images:{name:'board.png',mimeType:'image/png',buffer:raster}}});
 assert.ok(uploaded.ok(),'upload');const images=await (await request.get(origin+'/api/images?projectId='+project.id)).json();assert.equal(images.length,1);const imageId=images[0].id;
 await page.goto(origin+'/ai-connections');await page.locator('#connect-client').click();await page.locator('#dialog-next').click();
 await page.locator('#connection-name').fill('Runtime acceptance '+suffix);
 await page.getByLabel('AI workflow acceptance '+suffix,{exact:true}).check();
 for(const id of ['mcp-annotations-read','mcp-annotations-append','mcp-versions-read','mcp-jobs-read','mcp-versions-create','mcp-exports-create','mcp-images-read'])await page.locator('#scope-'+id).check();
 await page.locator('#dialog-next').click();await page.locator('#create-connection').click();await page.locator('#token-panel').waitFor({state:'visible'});
 const token=await page.locator('#connection-token').inputValue();assert.ok(token.length>20);
 await page.locator('#dismiss-token').click();
 async function call(name,args){
  const r=await fetch(gateway+'/v1/query',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({name:'libreflow_'+name,arguments:args})});
  const body=await r.json();assert.ok(r.ok,name+' HTTP '+r.status+' '+(body.error?.code||''));return body.result;
 }
 async function approve(proposal){
  await page.goto(origin+'/ai-connections#request='+proposal.id);
  await page.locator('#request-dialog').waitFor({state:'visible'});
  if(proposal.kind==='annotations.append')await page.locator('.annotation-review-image').waitFor({state:'visible'});
  const [approvedResponse]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/requests/'+proposal.id+'/approve')&&r.request().method()==='POST'),page.locator('#approve-request').click()]);assert.equal(approvedResponse.status(),200);
  const op=await call('get_operation',{projectId:project.id,operationId:proposal.id});
  if(op.status!=='approved'){
   for(let n=0;n<30;n++){await new Promise(r=>setTimeout(r,100));const fresh=await call('get_operation',{projectId:project.id,operationId:proposal.id});if(fresh.status==='approved')return;}
   assert.fail('approval did not complete');
  }
 }
 async function job(started){for(let n=0;n<80;n++){const state=await call('get_job',{projectId:project.id,jobId:started.jobId});if(state.status==='completed')return state;if(['failed','canceled'].includes(state.status))assert.fail('job '+state.status);await new Promise(r=>setTimeout(r,500));}assert.fail('job timeout');}
 const before=await call('get_annotations',{projectId:project.id,imageId});assert.equal(before.width,400);assert.equal(before.height,240);
 const addition=await call('propose_annotations',{projectId:project.id,requestKey:'add-'+suffix,imageId,expectedStateRevision:before.stateRevision,shapes:[{type:'bbox',label:'B',data:{x:100,y:60,width:70,height:50}}]});
 await approve(addition);
 const added=await call('apply_annotation_proposal',{projectId:project.id,operationId:addition.id});assert.equal(added.added,1);
 assert.deepEqual(await call('apply_annotation_proposal',{projectId:project.id,operationId:addition.id}),added);
 const version=await call('preview_version',{projectId:project.id,requestKey:'version-'+suffix,name:'',splitRatios:{train:1,valid:0,test:0},processing:{augmentation:{multiplier:2,horizontalFlip:.5}}});
 await approve(version);const versionJob=await job(await call('create_version',{projectId:project.id,operationId:version.id}));assert.ok(versionJob.result.versionId);assert.equal(versionJob.result.stats.sourceImages,1);assert.equal(versionJob.result.stats.generatedImages,1);assert.equal(versionJob.result.stats.images,2);
 const exp=await call('preview_export',{projectId:project.id,versionId:versionJob.result.versionId,requestKey:'export-'+suffix,format:'coco',includeImages:true,includeNull:true});
 await approve(exp);const exportJob=await job(await call('export_version',{projectId:project.id,operationId:exp.id}));
 const downloaded=await request.get(origin+exportJob.result.downloadPath);assert.equal(downloaded.status(),200);assert.match(downloaded.headers()['content-type'],/application\/zip/);assert.ok((await downloaded.body()).length>200);
 for(const width of [320,768,1280]){await page.setViewportSize({width,height:900});await page.goto(origin+'/ai-connections');await page.getByText('Runtime acceptance '+suffix,{exact:true}).first().waitFor({state:'visible'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow '+width);}
 assert.deepEqual(errors,[]);
 console.log('Real Docker workflow passed: browser setup and approvals, idempotent annotation append, 2x version, COCO ZIP download and responsive layouts.');
 await context.close();
 } finally {await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
