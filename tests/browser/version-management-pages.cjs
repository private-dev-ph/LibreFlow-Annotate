const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const express=require('express');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const app=express();app.use(express.static(path.join(__dirname,'../../public'),{extensions:['html']}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 try{for(const surface of ['project','dataset-lifecycle'])for(const width of [320,375,768,1280]){
  const page=await browser.newPage({viewport:{width,height:800}});page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));let deletes=0;
  let versions=[{id:'v6',sequence:6,name:'raw-complete-28',createdAt:'2026-11-07T05:40:00Z',canDelete:true,stats:{images:28,annotations:15820,bytes:1004386273},splits:{counts:{train:20,valid:6,test:2}},contentHash:'abc',manifestHash:'def'},
   {id:'read-only',sequence:5,name:'Read only',createdAt:'2026-11-06T00:00:00Z',canDelete:false,stats:{images:1,bytes:100},splits:{counts:{train:1}},contentHash:'ghi',manifestHash:'jkl'}];
  await page.route('**/api/**',route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;let body=[];
   if(p==='/api/auth/me')body={id:'tester',username:'Tester'};
   else if(p==='/api/projects/test')body={id:'test',userId:'tester',name:'Version fixture',labelClasses:[],collaborators:[],modelIds:[]};
   else if(p.endsWith('/versions/preview'))body={selection:{selected:28,annotated:28,background:0,excludedUnfinished:0,excludedByFilters:0},splits:{counts:{train:20,valid:6,test:2}},tags:[],message:'Ready'};
   else if(p.endsWith('/versions'))body=versions;
   else if(req.method()==='DELETE'&&p.endsWith('/versions/v6')){deletes++;versions=versions.filter(v=>v.id!=='v6');body={deleted:true,id:'v6'};}
   return route.fulfill({json:body});
  });
  const target=surface==='project'?'/project?projectId=test#versions':'/dataset-lifecycle?sourceType=project&sourceId=test#versions';
  await page.goto(`http://127.0.0.1:${server.address().port}${target}`);
  const button=page.locator('[data-delete-version="v6"]');await button.waitFor();
  assert.equal(await page.locator('[data-delete-version]').count(),1,'readonly version has no delete action');
  await button.click();
  assert.match(await page.locator('#version-delete-summary').textContent(),/v6.*raw-complete-28/);
  assert.equal(await page.locator('#version-delete-cancel').evaluate(el=>document.activeElement===el),true);
  assert.equal(await page.locator('.version-delete-dialog').evaluate(el=>{const b=el.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth+1&&b.top>=0&&b.bottom<=innerHeight+1}),true,`${surface} dialog fits ${width}`);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`${surface} page fits ${width}`);
  if(width===375)await page.screenshot({path:path.join(os.tmpdir(),`libreflow-${surface}-delete-mobile.png`)});
  await page.keyboard.press('Escape');assert.equal(deletes,0);
  if(surface==='dataset-lifecycle')await page.locator('#health-version').selectOption('v6',{force:true});
  await button.click();await page.locator('#version-delete-confirm').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-delete-version]').length===0);
  assert.equal(deletes,1);
  if(surface==='dataset-lifecycle')assert.equal(await page.locator('#health-version option[value="v6"]').count(),0,'deleted version removed from health selector');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: real project/lifecycle pages confirm deletion, preserve readonly cards, refresh lists, and fit320/375/768/1280px');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(e=>{console.error(e);process.exitCode=1});
