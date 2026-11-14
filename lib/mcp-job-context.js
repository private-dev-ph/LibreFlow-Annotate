'use strict';
const {dataFile,readJson}=require('./json-store');
const policy=require('./mcp-connections');
const operations=require('./mcp-operations');
const jobs=require('./job-runner');
const {runDataCommand}=require('./data-command');
function boundedSetting(name, fallback, minimum=1) {
  const value=process.env[name];
  if(value===undefined||value==='')return fallback;
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed)||parsed<minimum||parsed>fallback)throw new Error(name+' must be an integer from '+minimum+' to '+fallback+'.');
  return parsed;
}
const LIMITS=Object.freeze({
  images:boundedSetting('LIBREFLOW_MCP_MAX_IMAGES',100),
  totalPixels:boundedSetting('LIBREFLOW_MCP_MAX_PIXELS',250000000),
  tiles:boundedSetting('LIBREFLOW_MCP_MAX_TILES',1024),
  detections:boundedSetting('LIBREFLOW_MCP_MAX_DETECTIONS',20000),
  generatedImages:boundedSetting('LIBREFLOW_MCP_MAX_GENERATED_IMAGES',5000),
  runtimeMs:boundedSetting('LIBREFLOW_MCP_JOB_TIMEOUT_MS',15*60*1000,1000),
  activePerConnection:boundedSetting('LIBREFLOW_MCP_MAX_CONNECTION_JOBS',3),
  activePerUser:boundedSetting('LIBREFLOW_MCP_MAX_USER_JOBS',5),
  exportBytes:boundedSetting('LIBREFLOW_MCP_MAX_EXPORT_BYTES',5*1024**3),
  buildBytes:boundedSetting('LIBREFLOW_MCP_MAX_BUILD_BYTES',2*1024**3),
  draftDays:boundedSetting('LIBREFLOW_MCP_DRAFT_DAYS',7)
});
function assertQueueAvailable(principal) {
  const active=readJson(dataFile('jobs.json'),[]).filter(j=>j.userId===principal.userId&&j.type?.startsWith('mcp_')&&!jobs.TERMINAL_STATUSES.has(j.status));
  if(active.length>=LIMITS.activePerUser||active.filter(j=>j.input?.connectionId===principal.connectionId).length>=LIMITS.activePerConnection)
    throw operations.fail(429,'QUEUE_FULL','Wait for an existing AI job to finish before starting another.');
}
function queueApproved(principal,{projectId,operationId},kind,type,name,prepare=()=>[]) {
  return operations.consumeApproved(principal,projectId,operationId,kind,record=>{
    assertQueueAvailable(principal);
    const items=prepare(record);
    const connection=policy.currentRecord(principal);
    const job=jobs.createManagedJob({type,name,userId:principal.userId,projectId,
      input:{operationId:record.id,connectionId:principal.connectionId,connectionName:connection.name,
        principal:structuredClone(principal),approvedAt:record.approvedAt,expiresAt:record.expiresAt,payload:record.payload},
      items});
    return {jobId:job.id,projectId,status:job.status};
  });
}
function assertJobAuthority(job) {
  if(!job||!job.input?.principal)throw operations.fail(403,'FORBIDDEN','The AI job is unavailable.');
  const kind={mcp_inference:'inference.run',mcp_version:'versions.create',mcp_export:'exports.create'}[job.type];
  operations.assertAuthority(job.input.principal,job.projectId,kind);
  if(Date.parse(job.input.expiresAt)<=Date.now())throw operations.fail(409,'APPROVAL_EXPIRED','This approval expired. Create a new request.');
  if(job.cancelRequested)throw operations.fail(409,'JOB_CANCELED','This AI job was canceled.');
  return job.input.principal;
}
function jobDeadline(signal,timeoutMs=LIMITS.runtimeMs) {
  const timeout=AbortSignal.timeout(timeoutMs);
  return signal?AbortSignal.any([signal,timeout]):timeout;
}
function checkRunning(getJob,signal) {
  if(signal?.aborted)throw operations.fail(408,'JOB_STOPPED','The AI job was canceled or reached its time limit.');
  return assertJobAuthority(getJob());
}
function commitJob(getJob,signal,fn) {
  return runDataCommand(()=>{checkRunning(getJob,signal);return fn();});
}
function ownedJob(principal,projectId,jobId) {
  policy.requireProject(principal,projectId);
  if(!principal.grantedScopes.includes('mcp:jobs:read'))throw operations.fail(403,'SCOPE_REQUIRED','Job access is required.');
  const job=jobs.getManagedJob(principal.userId,principal.connectionId,jobId);
  if(!job||job.projectId!==projectId)throw operations.fail(404,'NOT_FOUND','AI job not found.');
  return job;
}
module.exports={LIMITS,queueApproved,assertJobAuthority,jobDeadline,checkRunning,commitJob,ownedJob};
