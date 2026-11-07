"use strict";

// One process serves the version store. Downloads may share a version; deletion is exclusive.
const active = new Map();
function acquireVersionOperation(versionId, operation) {
  if (!['download', 'delete'].includes(operation)) throw new TypeError('Unknown version operation.');
  const state = active.get(versionId) || { readers: 0, deleting: false };
  if (state.deleting || (operation === 'delete' && state.readers)) {
    const error = new Error('This version is being downloaded or deleted. Finish or cancel the download, then try again.');
    error.code = 'VERSION_BUSY';
    throw error;
  }
  if (operation === 'delete') state.deleting = true;
  else state.readers += 1;
  active.set(versionId, state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (operation === 'delete') state.deleting = false;
    else state.readers -= 1;
    if (!state.readers && !state.deleting) active.delete(versionId);
  };
}
module.exports = { acquireVersionOperation };
