// Build replaces these constants with the explicit static-asset allowlist.
const CACHE_NAME = '__CACHE_NAME__';
const ASSETS = ['__ASSET_LIST__'];
const allowed = new Set(ASSETS.map(asset => new URL(asset, self.registration.scope).pathname));
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('libreflow-assets-')&&key!==CACHE_NAME).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.search||!allowed.has(url.pathname))return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache=>(await cache.match(event.request))||fetch(event.request)));
});
