'use strict';
// Transport messages are fixed, so upstream paths, credentials and model output
// never become protocol errors.
const MESSAGES=Object.freeze({
  APPROVAL_REQUIRED:'Review and approve this request in LibreFlow before starting it.',
  APPROVAL_EXPIRED:'This approval expired. Create a new request.',
  SOURCE_CHANGED:'The image or dataset changed. Create and approve a fresh preview.',
  IDEMPOTENCY_CONFLICT:'This request key already identifies different settings. Use a new key.',
  QUEUE_FULL:'Wait for existing AI work to finish, or review pending requests.',
  SCOPE_REQUIRED:'This connection lacks a required permission.',
  WRITES_DISABLED:'AI actions are disabled on this server.',
  INVALID_ARGUMENT:'The action settings are invalid.',
  LIMIT_EXCEEDED:'The action exceeds the server processing budget. Use a smaller selection.',
  PREVIEW_CHANGED:'The reviewed request changed. Refresh its preview.',
  GRANT_CHANGED:'The connection changed. Create a new request.',
  NOT_FOUND:'The requested resource is unavailable.',
  SECURITY_STATE_UNAVAILABLE:'The saved AI request is unavailable. Check the server.',
});
function actionError(error){
 const message=MESSAGES[error?.code];
 return message?{status:Number(error.status)||400,code:error.code,message}:null;
}
module.exports={MESSAGES,actionError};
