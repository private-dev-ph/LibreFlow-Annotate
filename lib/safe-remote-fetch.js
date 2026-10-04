const dns=require('node:dns');
const net=require('node:net');
const {Agent}=require('undici');
const {isPrivateAddress}=require('./remote-address');

// Validate the addresses actually passed to the socket connector. A separate
// preflight lookup cannot prevent a DNS answer changing before connection.
function guardedLookup(lookup=dns.lookup) {
 return (hostname,options,callback)=>lookup(hostname,{all:true,verbatim:true,family:options?.family||0},(error,addresses)=>{
  if(error)return callback(error);
  if(!addresses?.length||addresses.some(item=>isPrivateAddress(item.address)))return callback(Object.assign(new Error('Private remote addresses are disabled'),{code:'ERR_PRIVATE_ADDRESS'}));
  if(options?.all)return callback(null,addresses);
  return callback(null,addresses[0].address,addresses[0].family);
 });
}
const publicDispatcher=new Agent({connect:{lookup:guardedLookup(),timeout:10000},connections:4,pipelining:1});
async function safeRemoteFetch(input,options={}, {allowPrivate=false,lookup}={}) {
 const url=new URL(input);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid remote URL');
 const hostname=url.hostname.replace(/^\[|\]$/g,'');
 if(!allowPrivate&&net.isIP(hostname)&&isPrivateAddress(hostname))throw new Error('Private remote addresses are disabled');
 // Explicit private-network overrides retain the preexisting operator policy.
 const dispatcher=allowPrivate?undefined:lookup?new Agent({connect:{lookup:guardedLookup(lookup),timeout:10000}}):publicDispatcher;
 try{return await globalThis.fetch(url,{...options,redirect:'manual',...(dispatcher?{dispatcher}:{})});}
 catch(error){if(lookup&&dispatcher)await dispatcher.close();throw error;}
}
module.exports={safeRemoteFetch,guardedLookup};
