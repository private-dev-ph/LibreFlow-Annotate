const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {safeRemoteFetch}=require('../lib/safe-remote-fetch');
test('socket DNS validation blocks a rebound private address before an HTTP connection',async()=>{
 let requests=0;const server=http.createServer((req,res)=>{requests++;res.end('private data');});server.listen(0,'127.0.0.1');await once(server,'listening');
 try {
  const lookup=(hostname,options,callback)=>{assert.equal(hostname,'rebound.example.test');callback(null,[{address:'127.0.0.1',family:4}]);};
  await assert.rejects(safeRemoteFetch(`http://rebound.example.test:${server.address().port}`,{signal:AbortSignal.timeout(2000)},{lookup}),error=>error.cause?.code==='ERR_PRIVATE_ADDRESS');assert.equal(requests,0);
  await assert.rejects(safeRemoteFetch(`http://127.0.0.1:${server.address().port}`),/Private/);assert.equal(requests,0);
 } finally {await new Promise(resolve=>server.close(resolve));}
});
