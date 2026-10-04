import { beginPkceRedirect, completePkceRedirect, requestGoogleGISAccessToken } from './oauth.mjs';
function requireId(value,label){if(!value)throw new Error(`Configure the public ${label} application ID in config.mjs before authorizing this deployment`);return value;}
async function googleSdk(){if(globalThis.google?.accounts?.oauth2)return;await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.referrerPolicy='no-referrer';script.onload=resolve;script.onerror=()=>reject(new Error('Google Identity Services could not load'));document.head.append(script);});}
export async function authorizeProvider(provider,config){
 if(provider==='google'){const clientId=requireId(config.googleClientId,'Google');await googleSdk();return (await requestGoogleGISAccessToken({clientId,prompt:'consent'})).accessToken;}
 const microsoft=provider==='onedrive';const clientId=requireId(microsoft?config.microsoftClientId:config.dropboxClientId,microsoft?'Microsoft':'Dropbox');
 await beginPkceRedirect({provider:microsoft?'microsoft':'dropbox',clientId,redirectUri:config.redirectUri||`${location.origin}${location.pathname}`,scopes:microsoft?['Files.ReadWrite']:[]});throw new Error('Redirecting to your storage provider');
}
export async function finishAuthorization(config){
 const query=new URLSearchParams(location.search);const fragment=new URLSearchParams(location.hash.slice(1));
 if(!query.has('code')&&!query.has('error')&&!fragment.has('code')&&!fragment.has('error'))return null;
 const microsoft=!!sessionStorage.getItem('libreflow.oauth.pkce.microsoft');const provider=microsoft?'microsoft':'dropbox';
 const result=await completePkceRedirect({provider,clientId:microsoft?config.microsoftClientId:config.dropboxClientId});return {provider:microsoft?'onedrive':'dropbox',token:result.accessToken};
}
