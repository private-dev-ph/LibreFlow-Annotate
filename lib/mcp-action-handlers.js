'use strict';
const ops=require('./mcp-operations');
const jobs=require('./job-runner');
const context=require('./mcp-job-context');
const {jobResultFields}=require('./mcp-action-catalog');
function jobSummary(job) {
 const result=job.result?Object.fromEntries(Object.entries(job.result).filter(([key])=>Object.hasOwn(jobResultFields,key))):null;
 return {jobId:job.id,projectId:job.projectId,type:job.type,status:job.status,progress:jobs.summarizeJob(job),result,error:job.error||null};
}
function createHandlers() {
 return {
  libreflow_preview_inference:(p,a)=>require('./mcp-inference-actions').previewInference(p,a),
  libreflow_start_inference:(p,a)=>require('./mcp-inference-actions').startInference(p,a),
  libreflow_get_inference_draft:(p,a)=>require('./mcp-inference-actions').getDraft(p,a),
  libreflow_propose_annotations:(p,a)=>require('./mcp-inference-actions').proposeAnnotations(p,a),
  libreflow_apply_annotation_proposal:(p,a)=>require('./mcp-inference-actions').applyAnnotations(p,a),
  libreflow_preview_version:(p,a)=>require('./mcp-version-actions').previewVersion(p,a),
  libreflow_create_version:(p,a)=>require('./mcp-version-actions').createVersion(p,a),
  libreflow_preview_export:(p,a)=>require('./mcp-export-actions').previewExport(p,a),
  libreflow_export_version:(p,a)=>require('./mcp-export-actions').exportVersion(p,a),
  libreflow_get_operation:(p,a)=>ops.publicProposal(ops.getInternalProposal(p,a.projectId,a.operationId)),
  libreflow_get_job:(p,a)=>jobSummary(context.ownedJob(p,a.projectId,a.jobId)),
  libreflow_cancel_job:(p,a)=>{
   context.ownedJob(p,a.projectId,a.jobId);
   jobs.cancelJob(p.userId,a.jobId);
   return jobSummary(context.ownedJob(p,a.projectId,a.jobId));
  },
 };
}
function registerActionJobs(){
 require('./mcp-inference-actions').registerInferenceJobs();
 require('./mcp-version-actions').registerVersionJobs();
 require('./mcp-export-actions').registerExportJobs();
}
module.exports={createHandlers,registerActionJobs,jobSummary};
