const assert=require('node:assert/strict');
const path=require('node:path');
const express=require('express');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const app=express(); app.use(express.static(path.join(__dirname,'../../public'),{extensions:['html']}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 try{
  for(const width of [1280,375,768]){
   const page=await browser.newPage({viewport:{width,height:812}});const errors=[];const failedRequests=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>failedRequests.push(`${r.url()} ${r.failure()?.errorText||''}`));page.on('dialog',dialog=>dialog.accept());
   const shapes=[{id:'part',label:'Far component',type:'bbox',data:{x:3200,y:2400,width:120,height:80}},{id:'point',label:'Inspection point',type:'point',data:{x:200,y:300}},{id:'class',label:'Board class',type:'classification',data:{value:'board'}}];
   await page.route('**/api/**',route=>{
    const p=new URL(route.request().url()).pathname;let body=[];
    if(p==='/api/auth/me')body={id:'tester',username:'Tester'};
    else if(p==='/api/projects/test')body={id:'test',name:'Navigation fixture',labelClasses:[]};
    else if(p==='/api/images/browse'){
      const requestUrl=new URL(route.request().url()),pageNumber=Number(requestUrl.searchParams.get('page')||1);
      const pageImages=Array.from({length:pageNumber===1?100:101},(_,offset)=>{const index=(pageNumber-1)*100+offset;return {id:index===0?'board':`image-${index}`,filename:'board.svg',originalName:index===0?'Board':`Board ${index}`,width:4000,height:3000,annotated:index===0,isNull:false,tags:[]}});
      body={groups:[{key:'none',label:'',total:201,offset:0,items:pageImages}],page:pageNumber,pageSize:100,total:201,totalPages:3,projectTotal:201,scopeTotal:201,scopeAnnotatedTotal:1,scopeUnannotatedTotal:200,scopeNullTotal:0,annotatedTotal:1,unannotatedTotal:200,nullTotal:0,requestedIndex:-1};
    }
    else if(p==='/api/annotations/board')body=shapes;
    else if(p.includes('/review'))body={review:{status:'unannotated'},permissions:{},collaborators:[],comments:[],history:[]};
    return route.fulfill({json:body});
   });
   await page.route('**/uploads/board.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"><rect width="4000" height="3000" fill="#324d46"/></svg>'}));
   await page.goto(`http://127.0.0.1:${server.address().port}/annotator?projectId=test`);
   await page.waitForFunction(()=>typeof Canvas!=='undefined'&&Canvas.getImageSize()?.width===4000);
   const mobile=width<=1000;
   if(mobile)await page.selectOption('#mobile-panel','details');
   await page.evaluate(()=>{
    window.originalShapes=JSON.stringify(Canvas.getShapes());window.focusCalls=[];
    const originalFocus=Canvas.focusShape;Canvas.focusShape=function(id){window.focusCalls.push(id);return originalFocus.call(Canvas,id)};
    const ctx=document.getElementById('annotation-canvas').getContext('2d'),originalDraw=ctx.drawImage.bind(ctx);
    ctx.drawImage=function(...args){const m=this.getTransform();window.view={scale:m.a,x:m.e,y:m.f};return originalDraw(...args)};
     Canvas.fitToScreen();
     const canvas=document.getElementById('annotation-canvas'),rect=canvas.getBoundingClientRect();
     canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:-240,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,bubbles:true,cancelable:true}));
     window.initialView={...window.view};
   });
   const first=page.locator('#annotation-list li').filter({hasText:'Far component'});
   assert.equal(await first.getAttribute('title'),'Double-click or press Enter to center on annotation while keeping zoom');
   const handle=await first.elementHandle();await first.click();
   assert.equal(await handle.evaluate(el=>el.isConnected),true,'selection must retain row for native double-click');
   assert.deepEqual(await page.evaluate(()=>window.view),await page.evaluate(()=>window.initialView),'single-click only selects');
   await first.dblclick();
   await page.waitForFunction(()=>window.focusCalls.length===1);
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const focused=await page.evaluate(()=>({view:window.view,width:document.getElementById('annotation-canvas').width,height:document.getElementById('annotation-canvas').height,initial:window.initialView.scale,panel:document.getElementById('annotator-body').dataset.mobilePanel}));
   assert.equal(focused.view.scale,focused.initial,'double-click keeps current zoom');
   assert.ok(Math.abs(3260*focused.view.scale+focused.view.x-focused.width/2)<.01,'annotation centered horizontally');
   assert.ok(Math.abs(2440*focused.view.scale+focused.view.y-focused.height/2)<.01,'annotation centered vertically');
   if(mobile)assert.equal(focused.panel,'canvas','mobile returns to visible canvas');
   assert.equal(await page.evaluate(()=>JSON.stringify(Canvas.getShapes())===window.originalShapes&&!Canvas.canUndo()&&!document.getElementById('save-indicator').classList.contains('show')),true,'view navigation does not edit annotations');
   if(mobile)await page.selectOption('#mobile-panel','details');
   const point=page.locator('#annotation-list li').filter({hasText:'Inspection point'});await point.focus();await page.keyboard.press('Enter');
   await page.waitForFunction(()=>window.focusCalls.length===2);
   assert.equal(await page.evaluate(()=>Canvas.getSelected().id),'point');
   if(mobile)await page.selectOption('#mobile-panel','details');
   const beforeClass=await page.evaluate(()=>({...window.view}));
   await page.locator('#annotation-list li').filter({hasText:'Board class'}).dblclick();
   assert.deepEqual(await page.evaluate(()=>window.view),beforeClass,'classification has no location to zoom to');
   if(mobile)assert.equal(await page.locator('#mobile-panel').inputValue(),'details');
   const callsBeforeDelete=await page.evaluate(()=>window.focusCalls.length);
   await page.locator('#annotation-list li').filter({hasText:'Far component'}).locator('.ann-del-btn').click();
   assert.equal(await page.evaluate(()=>window.focusCalls.length),callsBeforeDelete,'delete does not trigger view navigation');
   assert.equal(await page.evaluate(()=>Canvas.getShapes().length),2);
   await page.evaluate(()=>Canvas.undo());
   assert.equal(await page.evaluate(()=>JSON.stringify(Canvas.getShapes())===window.originalShapes),true);
   if(mobile)await page.selectOption('#mobile-panel','details');
   await page.locator('#inference-tiling-details').evaluate(el=>{el.open=true});
   const panel=await page.locator('#right-panel').boundingBox();
   await page.mouse.move(panel.x+panel.width/2,Math.min(792,panel.y+panel.height-20));
   for(let attempt=0;attempt<5;attempt++){await page.mouse.wheel(0,4000);await page.waitForTimeout(60)}
   assert.equal(await page.locator('#btn-auto-infer').evaluate(el=>{const b=el.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight}),true,'actual app can scroll to inference action');
   await page.evaluate(()=>document.querySelector('.annotator-page-controls [data-page="next"]')?.click());
   await page.waitForFunction(()=>document.getElementById('image-nav-label').textContent==='101 / 201');
   assert.deepEqual(errors,[]);
   await page.close();
  }
  console.log('PASS: native double-click and Enter focus annotations; mobile reveals canvas; selection, deletion and data remain correct');
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
