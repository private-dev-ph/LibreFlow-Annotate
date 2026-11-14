'use strict';
const {pipeline}=require('node:stream/promises');
const {actionError}=require('./mcp-action-errors');
async function sendExportDownload(req,res,principal,{reauthenticate}={}) {
  let download,monitor,checking=false;
  const controller=new AbortController();
  const abort=()=>controller.abort();
  res.once('close',abort);
  try {
    download=require('./mcp-export-actions').openDownload(principal,{projectId:req.params.projectId,exportId:req.params.exportId,signal:controller.signal});
    if(reauthenticate) {
      if(!await reauthenticate())throw Object.assign(new Error(),{status:401});
      monitor=setInterval(async()=>{
        if(checking||controller.signal.aborted)return;checking=true;
        try{if(!await reauthenticate())controller.abort();}catch{controller.abort();}finally{checking=false;}
      },250);monitor.unref?.();
    }
    res.set({'Content-Type':'application/zip','Content-Length':String(download.size),
      'Content-Disposition':'attachment; filename="'+download.filename.replace(/[^A-Za-z0-9._-]/g,'_')+'"',
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    await pipeline(download.stream,res,{signal:controller.signal});
  }catch(error) {
    if(res.headersSent)res.destroy();
    else {
      const safe=actionError(error);
      const status=safe?.status||([401,403,404].includes(error.status)?error.status:503);
      res.status(status).json({error:{code:safe?.code||'DOWNLOAD_UNAVAILABLE',message:safe?.message||'This export is unavailable. Check the connection and export expiry.'}});
    }
  }finally{clearInterval(monitor);res.removeListener('close',abort);download?.close();}
}
module.exports={sendExportDownload};
