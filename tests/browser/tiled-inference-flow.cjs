const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const express = require(path.join(process.cwd(),'node_modules/express'));
(async()=>{
 const app=express(); app.use(express.static(path.join(process.cwd(),'public'),{extensions:['html']}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 try {
  for(const width of [375,1024]){
   const page=await browser.newPage({viewport:{width,height:884}}); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
   let payload; let delayed=false; let release; let requested;
   const annotations=[{id:'manual',type:'bbox',label:'part',data:{x:10,y:10,width:100,height:100}}];
   const results=[{type:'bbox',label:'part',confidence:.9,data:{x:800,y:500,width:100,height:50}},{type:'bbox',label:'other',confidence:.8,data:{x:800,y:500,width:100,height:50}}];
   await page.route('**/api/**',async route=>{
    const req=route.request(), url=new URL(req.url()), p=url.pathname; let body=[];
    if(p==='/api/auth/me') body={id:'test',username:'Tester'};
    else if(p==='/api/projects/test') body={id:'test',name:'Board test',labelClasses:[{name:'part',color:'#b44b40'},{name:'other',color:'#259282'}]};
    else if(p==='/api/images') body=[{id:'one',filename:'one.svg',originalName:'Board one',width:2050,height:1300},{id:'two',filename:'two.svg',originalName:'Board two',width:900,height:500}];
    else if(p==='/api/models') body=[{id:'det',name:'Detector',type:'detection'},{id:'cls',name:'Classifier',type:'classification'}];
    else if(p==='/api/annotations/one') body=annotations;
    else if(p==='/api/models/det/infer'||p==='/api/models/cls/infer') {payload=req.postDataJSON(); requested?.(); if(delayed)await new Promise(r=>release=r); body={results,count:2,message:'Done',...(payload.tiling?{tiling:{enabled:true,tileCount:6,workers:2,duplicatesRemoved:2}}:{})};}
    else if(p.includes('/review')) body={review:{status:'unannotated'},permissions:{},collaborators:[],comments:[],history:[]};
    await route.fulfill({json:body});
   });
   await page.route('**/uploads/*.svg',route=>route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${route.request().url().includes('one')?2050:900}" height="${route.request().url().includes('one')?1300:500}"><rect width="100%" height="100%" fill="#324d46"/></svg>`}));
   await page.goto(`http://127.0.0.1:${server.address().port}/annotator?projectId=test`);
   await page.waitForFunction(()=>typeof Canvas!=='undefined'&&Canvas.getImageSize()?.width===2050);
   if(width<900) await page.selectOption('#mobile-panel','details');
   await page.selectOption('#auto-model-select','det');
   await page.locator('#inference-tiling-details summary').click();
   await page.check('#tiling-enabled');
   assert.match(await page.locator('#tiling-estimate').innerText(),/6 tiles/);
   await page.locator('#infer-conf-slider').evaluate(el=>{el.value='.55';el.dispatchEvent(new Event('input',{bubbles:true}));});
   await page.click('#btn-auto-infer');
   await page.waitForFunction(()=>document.getElementById('auto-status').textContent.includes('2 annotation(s) applied'));
   assert.equal(payload.confThreshold,.55); assert.equal(payload.tiling.maxDetections,1000);
   assert.equal(await page.evaluate(()=>Canvas.getShapes().length),3);
   assert.deepEqual(await page.evaluate(()=>Canvas.getImageSize()),{width:2050,height:1300});
   assert.match(await page.locator('#auto-status').innerText(),/6 tiles.*2 duplicates merged/);
   await page.selectOption('#auto-model-select','cls');
   await page.click('#btn-auto-infer');
   await page.waitForFunction(()=>!document.getElementById('btn-auto-infer').disabled);
   assert.equal(payload.tiling,undefined,'remembered toggle must not block ordinary classifier');
   await page.selectOption('#auto-model-select','det');
   delayed=true; const began=new Promise(r=>requested=r); await page.click('#btn-auto-infer'); await began;
   page.on('dialog',d=>d.accept());
   await page.locator('#btn-next-img').evaluate(el=>el.click());
   await page.waitForFunction(()=>Canvas.getImageSize()?.width===900); assert.equal(await page.locator('#btn-auto-infer').isDisabled(),true,'navigation must not allow overlapping inference requests'); release();
   await page.waitForFunction(()=>document.getElementById('auto-status').textContent.includes('discarded'));
   assert.equal(await page.evaluate(()=>Canvas.getShapes().length),0);
   assert.deepEqual(errors,[]);
   await page.locator('#tiling-enabled').scrollIntoViewIfNeeded();
   await page.screenshot({path:path.join(process.env.TEMP,`libreflow-tiling-${width}.png`)});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.close();
  }
  console.log('PASS: full annotator tiled payload, coordinates, class overlaps, classifier fallback, stale response, phone/tablet');
 } finally {await browser.close(); await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});

