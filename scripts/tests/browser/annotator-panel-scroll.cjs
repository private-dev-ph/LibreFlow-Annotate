const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../../..');
const html=fs.readFileSync(path.join(root,'public/annotator.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 try{
  for(const [width,height] of [[1280,800],[1104,600],[1024,768],[375,812],[667,375],[768,1024]]){
   const page=await browser.newPage({viewport:{width,height}});
   await page.setContent(html);
   for(const file of ['nav','icons','annotator','theme']) await page.addStyleTag({path:path.join(root,`public/css/${file}.css`)});
   await page.evaluate(()=>{
    document.getElementById('annotator-body').dataset.mobilePanel='details';
    document.getElementById('inference-tiling-details').open=true;
    document.getElementById('tiling-fields').disabled=false;
    document.getElementById('tiling-enabled').checked=true;
    document.getElementById('review-details').open=true;
    const list=document.getElementById('annotation-list');
    for(let i=0;i<120;i++){const row=document.createElement('li');row.textContent=`Component ${i+1}`;list.appendChild(row)}
   });
   const panel=page.locator('#right-panel');
   const rect=await panel.boundingBox();
   await page.mouse.move(rect.x+rect.width/2,Math.min(height-20,rect.y+rect.height-20));
   for(let attempt=0;attempt<5;attempt++){await page.mouse.wheel(0,4000);await page.waitForTimeout(60);}
   await page.waitForFunction(()=>document.getElementById('right-panel').scrollTop>0,{},{timeout:1500}).catch(()=>{});
   const state=await page.evaluate(()=>{
    const p=document.getElementById('right-panel'),r=p.getBoundingClientRect(),b=document.getElementById('btn-auto-infer').getBoundingClientRect();
    return {scrollTop:p.scrollTop,overflow:getComputedStyle(p).overflowY,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,buttonTop:b.top,buttonBottom:b.bottom,panelTop:r.top,panelBottom:r.bottom};
   });
   console.log(JSON.stringify({width,height,...state}));
   assert.ok(state.scrollTop>0,`Tiling panel must scroll using mouse wheel at ${width}x${height}`);
   assert.ok(state.buttonTop>=state.panelTop&&state.buttonBottom<=Math.min(height,state.panelBottom),`Run button must be reachable at ${width}x${height}`);
   for(let attempt=0;attempt<5;attempt++){await page.mouse.wheel(0,-4000);await page.waitForTimeout(60);}
   await page.waitForFunction(()=>document.getElementById('right-panel').scrollTop===0,{},{timeout:1500});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.close();
  }
  console.log('PASS: actual annotation panel scrolls down and back up across desktop, phone and tablet layouts');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});

