const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawn}=require('node:child_process');
test('real self-hosted runtime rejects CSRF, persists auth, regenerates sessions and keeps local APIs usable',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'libreflow-runtime-'));const port=24000+Math.floor(Math.random()*10000);const origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server.js'],{env:{...process.env,NODE_ENV:'development',PORT:String(port),LIBREFLOW_DATA_DIR:path.join(directory,'data'),SESSION_STORE_DIR:path.join(directory,'sessions'),APP_ORIGINS:origin},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);t.after(async()=>{child.kill();await new Promise(resolve=>child.once('exit',resolve));fs.rmSync(directory,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(`${origin}/login`);if(r.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,output);
 const payload={username:' Runtime user ',email:' RUNTIME@example.test ',password:'Safe-test-password-123'};const request=(route,body,headers={})=>fetch(`${origin}${route}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await request('/api/auth/register',payload,{Origin:'https://evil.example.test'})).status,403);
 const registration=await request('/api/auth/register',payload,{Origin:origin});assert.equal(registration.status,201,await registration.clone().text());const firstCookie=registration.headers.get('set-cookie');assert.match(firstCookie,/HttpOnly/i);assert.match(firstCookie,/SameSite=Lax/i);assert.equal((await registration.json()).email,'runtime@example.test');
 const cookie=firstCookie.split(';')[0];assert.equal((await fetch(`${origin}/api/auth/me`,{headers:{Cookie:cookie}})).status,200);
 const login=await request('/api/auth/login',{email:'runtime@example.test',password:payload.password},{Origin:origin,Cookie:cookie});assert.equal(login.status,200);assert.notEqual(login.headers.get('set-cookie').split(';')[0],cookie);
 assert.equal((await fetch(`${origin}/api/auth/me`,{headers:{Cookie:cookie}})).status,401);
 const newCookie=login.headers.get('set-cookie').split(';')[0];const project=await request('/api/projects',{name:'runtime project'},{Origin:origin,Cookie:newCookie});assert.equal(project.status,201);
 const result=await fetch(`${origin}/api/projects`,{headers:{Cookie:newCookie}});assert.equal(result.status,200);assert.ok((await result.json()).some(p=>p.name==='runtime project'));
 assert.ok(fs.readdirSync(path.join(directory,'sessions')).some(n=>n.endsWith('.json')));assert.match(result.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
