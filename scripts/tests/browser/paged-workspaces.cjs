const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const app = express();
  app.use(express.static(path.join(__dirname, '../../../public'), { extensions: ['html'] }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  try {
    const landscape = process.argv.includes('--landscape');
    const viewport = landscape ? {width:844, height:390} : {width:375, height:812};
    const p = await browser.newPage({ viewport, reducedMotion:'reduce' });
    await p.addInitScript(mode => localStorage.setItem('libreflow_theme_mode', mode), landscape ? 'dark' : 'light');
    p.setDefaultTimeout(7000);
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    const url = 'http://127.0.0.1:' + server.address().port;
    const items = Array.from({length:45}, (_,i) => ({ id:'id'+i, name:'Inspection '+i, userId:'owner', username:'User'+i, type:'detector', projectId:'one' }));
    const source = {id:'one',userId:'owner',name:'One',collaborators:items,labelClasses:items,modelIds:[]};
    const images = items.map(v => ({filename:v.name}));
    const health = {summary:{score:100}, classBalance:[], dimensions:{widths:{},heights:{},aspectBuckets:{}}, boundingBoxes:{buckets:{},relativeArea:{}}, spatialHeatmap:{max:0,cells:[]}, geometryIssues:[], exactDuplicates:items.map(v=>({contentHash:v.name,images})),filenameCollisions:[],splitLeakage:[]};
    let submittedKeyProjects;
    await p.route('**/api/**', async r => {
      const u = new URL(r.request().url()), path = u.pathname;
      const page = Number(u.searchParams.get('page') || 1);
      let body = [];
      if(path.endsWith('/auth/me'))body={id:'owner',username:'Owner'};
      else if(path.endsWith('/health'))body=health;
      else if(path.endsWith('/source-options'))body={supportsBatches:true,total:12,eligible:12,totalBatches:1,totalPages:1,page:1,unbatched:{},batches:[{id:'parent',name:'Parent',subBatchCount:45,subBatches:u.searchParams.has('batchId')?items.slice((Number(u.searchParams.get('subPage'))-1)*20,Number(u.searchParams.get('subPage'))*20):[]}],...(u.searchParams.has('batchId')?{childPage:Number(u.searchParams.get('subPage')),totalPages:3}:{})};
      else if(path.endsWith('/projects/one')||path.endsWith('/datasets/one'))body=source;
      else if(path.endsWith('/models'))body=items;
      else if(path.endsWith('/models/available/browse')){
        const found=items.filter(row => row.name.toLowerCase().includes((u.searchParams.get('q') || '').toLowerCase()));
        body={items:found.slice((page-1)*12,page*12).map(row => ({...row,sourceProjectName:'Source '+row.projectId})),page,total:found.length,totalPages:Math.ceil(found.length/12)||1,pageSize:12};
      }
      else if(path.endsWith('/projects/browse')){
        const size = Number(u.searchParams.get('pageSize') || 50);
        const found = items.filter(item => item.name.includes(u.searchParams.get('q') || ''));
        body={items:found.slice((page-1)*size,page*size),page,total:found.length,totalPages:Math.ceil(found.length/size)||1,pageSize:size};
      } else if(path.endsWith('/automation/api-keys') && r.request().method()==='POST'){
        submittedKeyProjects=r.request().postDataJSON().projectIds;
        body={token:'fixture'};
      }
      else if(path.endsWith('/webhook-deliveries')){
        const found=items.filter(row => row.name.toLowerCase().includes((u.searchParams.get('q') || '').toLowerCase()));
        body={items:found.slice((page-1)*12,page*12).map(row=>({...row,status:'failed',event:row.name})),page,total:found.length,totalPages:Math.ceil(found.length/12)||1};
      }
      else if(path.endsWith('/browse')||path.endsWith('/audit')||path.includes('/automation/') && u.searchParams.has('page'))body={items:[],page:1,totalPages:1,pageSize:12,total:0,counts:{},members:[]};
      else if(path.endsWith('/catalog'))body={items:[]};
      else if(path.includes('/mcp/connections/browse/')){
        const found = path.endsWith('/requests') ? [] : items.filter(item => item.name.toLowerCase().includes((u.searchParams.get('q') || '').toLowerCase()));
        body={items:found.slice((page-1)*12,page*12).map(v=>({...v,projectIds:[],scopes:[],activity:[]})),projects:[],page,total:found.length,totalPages:Math.ceil(found.length/12)||1};
      }
      else if(path.endsWith('/connections'))body={enabled:true,scopes:[],projects:items,connections:items.map(v=>({...v,projectIds:[],scopes:[],activity:[]}))};
      else if(path.endsWith('/requests'))body={requests:[]};
      return r.fulfill({json:body});
    });
    await p.goto(url+'/dataset-lifecycle?sourceType=project&sourceId=one#health');
    await p.locator('#btn-run-health').click();
    const group=p.locator('.finding-group').filter({hasText:'Exact duplicate groups'}).first();
    await group.getByRole('button',{name:'Next Exact duplicate groups'}).click();
    await group.locator('summary').first().click();
    await group.getByRole('button',{name:'Next images'}).click();
    assert.match(await group.locator('details[open]').innerText(),/Inspection 39/);
    await p.locator('[data-tab="versions"]').click();
    await p.locator('[name="version-source-mode"][value="batches"]').check();
    await p.locator('[data-source-group] summary').click();
    await p.locator('[data-child-step="1"]').click();
    await p.locator('[data-source-sub="id21"]').check();
    await p.locator('[data-child-step="-1"]').click();
    assert.match(await p.locator('.version-source-summary').innerText(),/Inspection 21/);
    await p.goto(url+'/project?projectId=one');
    const labelControls=p.locator('#labels-list').locator('xpath=preceding-sibling::*[1]');
    await labelControls.getByRole('button',{name:'Next labels'}).click();
    assert.equal(await p.locator('#labels-list .label-chip').first().getAttribute('data-idx'),'12');
    await labelControls.locator('input').fill('Inspection 44');
    assert.equal(await p.locator('#labels-list .label-chip').first().getAttribute('data-idx'),'44');
    await p.locator('[data-tab="models"]').click();
    await p.locator('#btn-toggle-existing-models').click();
    await p.locator('[data-copy-model="id0"]').waitFor();
    await p.locator('[data-existing-model-next]').click();
    await p.locator('[data-copy-model="id12"]').waitFor();
    await p.locator('#existing-model-search').fill('Inspection 44');
    await p.locator('[data-copy-model="id44"]').waitFor();
    assert.equal(await p.locator('[data-copy-model]').count(),1);
    await p.goto(url+'/jobs#mcp');
    await p.locator('#client-search').fill('Inspection 44');
    await p.locator('[data-connection-id="id44"]').waitFor();
    assert.equal(await p.locator('[data-connection-id]').count(),1);
    await p.goto(url+'/jobs#integrations');
    const deliveryNav=p.locator('#deliveries-list').locator('xpath=preceding-sibling::*[1]');
    await deliveryNav.getByRole('button',{name:'Next'}).click();
    await p.locator('[data-delivery-retry="id12"]').waitFor();
    await deliveryNav.locator('input').fill('Inspection 44');
    await p.locator('[data-delivery-retry="id44"]').waitFor();
    assert.equal(await p.locator('[data-delivery-retry]').count(),1);
    await p.goto(url+'/jobs#api-keys');
    await p.getByRole('checkbox',{name:'Restrict key to Inspection 1',exact:true}).check();
    await p.locator('[data-project-restriction-next]').click();
    await p.getByRole('checkbox',{name:'Restrict key to Inspection 14',exact:true}).check();
    const projectSearch=p.getByRole('searchbox',{name:'Search projects to restrict'});
    await projectSearch.fill('Inspection 44');
    await p.getByRole('checkbox',{name:'Restrict key to Inspection 44',exact:true}).waitFor();
    assert.equal(await projectSearch.evaluate(el=>el===document.activeElement),true);
    assert.match(await p.locator('[data-project-restriction-count]').textContent(),/2 projects selected/);
    await p.getByRole('button',{name:'Create API key',exact:true}).click();
    await p.locator('#api-key-token:not(.hidden)').waitFor();
    assert.deepEqual(submittedKeyProjects,['id1','id14']);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors,[]);
    console.log('PASS: health, source selections, labels, model choices, MCP and deliveries at ' + viewport.width + 'x' + viewport.height);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
