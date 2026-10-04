// Google's official picker grants drive.file access to existing selected files.
async function pickerSdk() {
 if (globalThis.google?.picker) return globalThis.google.picker;
 if (!globalThis.gapi) await new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src='https://apis.google.com/js/api.js';script.referrerPolicy='no-referrer';script.onload=resolve;script.onerror=()=>reject(new Error('Google Picker could not load'));document.head.append(script);
 });
 await new Promise((resolve,reject)=>globalThis.gapi.load('picker',{callback:resolve,onerror:()=>reject(new Error('Google Picker is unavailable')),timeout:15000,ontimeout:()=>reject(new Error('Google Picker timed out'))}));
 return globalThis.google.picker;
}
export async function chooseGoogleFiles({token,appId,developerKey,folder=false,origin=globalThis.location?.origin,sdk}={}) {
 if(!token||!appId||!developerKey)throw new Error('Authorize Drive and configure the public Google project number and restricted Picker API key');
 const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin)throw new Error('Google Picker requires an exact HTTPS origin');
 const p=sdk||await pickerSdk();
 return new Promise((resolve,reject)=>{
  const view=new p.DocsView(folder?p.ViewId.FOLDERS:p.ViewId.DOCS);
  if(folder)view.setIncludeFolders(true).setSelectFolderEnabled(true);else view.setMimeTypes('image/png,image/jpeg,image/webp,image/bmp,image/gif');
  let picker;let settled=false;
  const finish=(error,docs)=>{if(settled)return;settled=true;picker?.setVisible(false);if(error)reject(error);else resolve(docs);};
  const builder=new p.PickerBuilder().setAppId(appId).setDeveloperKey(developerKey).setOAuthToken(token).setOrigin(origin).addView(view).setCallback(data=>{
   if(data.action===p.Action.CANCEL)return finish(null,[]);
   if(data.action!==p.Action.PICKED)return;
   const docs=data.docs;
   if(!Array.isArray(docs)||docs.length>200||docs.some(d=>typeof d.id!=='string'||!d.id||d.id.length>512))return finish(new Error('Google Picker returned invalid selection'));
   finish(null,docs.map(d=>({id:d.id})));
  });
  if(!folder)builder.enableFeature(p.Feature.MULTISELECT_ENABLED);
  picker=builder.build();picker.setVisible(true);
 });
}
