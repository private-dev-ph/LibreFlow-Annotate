/**
 * jobs.js  –  Job state & XHR upload tracking module
 *
 * Usage:
 *   const jobId = Jobs.upload(projectId, formData, { name:'Photos.zip', onDone, onError })
 *   Jobs.getAll()   → array of job objects (from localStorage)
 *   Jobs.clear()    → remove all completed/failed jobs
 *
 * Events:
 *   document dispatches 'jobs:updated'  whenever a job changes state
 */

const Jobs = (() => {
  const LS_KEY = 'libreflow_jobs';
  const MAX_STORED = 50;

  //─── Persistence ─────────────────────────────────────────────────────────────

  function load() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
    catch { return []; }
  }

  function save(jobs) {
    // keep most recent MAX_STORED entries
    const trimmed = jobs.slice(-MAX_STORED);
    localStorage.setItem(LS_KEY, JSON.stringify(trimmed));
  }

  function emit() {
    document.dispatchEvent(new CustomEvent('jobs:updated'));
  }

  function upsert(job) {
    const jobs = load();
    const idx = jobs.findIndex(j => j.id === job.id);
    if (idx >= 0) jobs[idx] = job;
    else jobs.push(job);
    save(jobs);
    emit();
  }

  //─── Public API ──────────────────────────────────────────────────────────────

  function getAll() { return load().reverse(); }                  // newest first
  function get(id)  { return load().find(j => j.id === id) || null; }

  /**
   * Upload files via XHR with progress tracking.
   * @param {string}   projectId
   * @param {FormData} formData
   * @param {object}   opts  { name, fileCount, onDone, onError }
   * @returns {string} jobId
   */
  function upload(projectId, formData, opts = {}) {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const name  = opts.name      || 'Upload';
    const count = opts.fileCount || '?';

    const job = {
      id:        jobId,
      type:      'upload',
      name,
      projectId,
      fileCount: count,
      status:    'running',     // running | done | error
      progress:  0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error:     null,
    };
    upsert(job);

    // Show notification
    const notifyId = (typeof Notify !== 'undefined')
      ? Notify.progress(`Uploading ${name}`, `0 % — ${count} file${count !== 1 ? 's' : ''}`, 0)
      : null;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/images/upload?projectId=${encodeURIComponent(projectId)}`);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      const updated = { ...get(jobId), progress: pct, updatedAt: new Date().toISOString() };
      upsert(updated);
      if (notifyId) Notify.updateProgress(notifyId, pct, `${pct}% — ${name}`);
    };

    xhr.onload = () => {
      let resp = null;
      try { resp = JSON.parse(xhr.responseText); } catch {}

      if (xhr.status >= 200 && xhr.status < 300) {
        const updated = { ...get(jobId), status: 'done', progress: 100, updatedAt: new Date().toISOString() };
        upsert(updated);
        if (notifyId) Notify.promoteCompleted(notifyId, true, `${name} uploaded`);
        if (typeof opts.onDone === 'function') opts.onDone(resp);
      } else {
        const errMsg = resp?.error || `Server error ${xhr.status}`;
        const updated = { ...get(jobId), status: 'error', error: errMsg, updatedAt: new Date().toISOString() };
        upsert(updated);
        if (notifyId) Notify.promoteCompleted(notifyId, false, `Upload failed: ${errMsg}`);
        if (typeof opts.onError === 'function') opts.onError(errMsg);
      }
    };

    xhr.onerror = () => {
      const errMsg = 'Network error';
      const updated = { ...get(jobId), status: 'error', error: errMsg, updatedAt: new Date().toISOString() };
      upsert(updated);
      if (notifyId) Notify.promoteCompleted(notifyId, false, `Upload failed: ${errMsg}`);
      if (typeof opts.onError === 'function') opts.onError(errMsg);
    };

    xhr.send(formData);
    return jobId;
  }

  /**
   * Upload a model file via XHR.
   */
  function uploadModel(projectId, formData, opts = {}) {
    const jobId = `job-model-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const name  = opts.name || 'Model';

    const job = {
      id:        jobId,
      type:      'model_upload',
      name,
      projectId,
      status:    'running',
      progress:  0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error:     null,
    };
    upsert(job);

    const notifyId = (typeof Notify !== 'undefined')
      ? Notify.progress(`Uploading model: ${name}`, '0%', 0)
      : null;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/models/upload`);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      const updated = { ...get(jobId), progress: pct, updatedAt: new Date().toISOString() };
      upsert(updated);
      if (notifyId) Notify.updateProgress(notifyId, pct, `${pct}% — ${name}`);
    };

    xhr.onload = () => {
      let resp = null;
      try { resp = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        const updated = { ...get(jobId), status: 'done', progress: 100, updatedAt: new Date().toISOString() };
        upsert(updated);
        if (notifyId) Notify.promoteCompleted(notifyId, true, `Model "${name}" uploaded`);
        if (typeof opts.onDone === 'function') opts.onDone(resp);
      } else {
        const errMsg = resp?.error || `Server error ${xhr.status}`;
        const updated = { ...get(jobId), status: 'error', error: errMsg, updatedAt: new Date().toISOString() };
        upsert(updated);
        if (notifyId) Notify.promoteCompleted(notifyId, false, `Model upload failed: ${errMsg}`);
        if (typeof opts.onError === 'function') opts.onError(errMsg);
      }
    };

    xhr.onerror = () => {
      const updated = { ...get(jobId), status: 'error', error: 'Network error', updatedAt: new Date().toISOString() };
      upsert(updated);
      if (notifyId) Notify.promoteCompleted(notifyId, false, 'Model upload failed: network error');
      if (typeof opts.onError === 'function') opts.onError('Network error');
    };

    xhr.send(formData);
    return jobId;
  }

  function clearCompleted() {
    const jobs = load().filter(j => j.status === 'running');
    save(jobs);
    emit();
  }

  function clearAll() {
    save([]);
    emit();
  }

  /**
   * Upload an arbitrarily large set of files (images + ZIPs) to a project,
   * automatically chunking them into sequential XHR requests (≤100 files each).
   * All chunks land in the same server-side batch.
   *
   * @param {string}   projectId
   * @param {File[]}   files        – flat array of File objects
   * @param {object}   opts         – { name, batchName, onDone, onError, onProgress }
   * @returns {string} jobId
   */
  function uploadChunked(projectId, files, opts = {}) {
    const CHUNK      = 100;
    const jobId      = `job-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const name       = opts.name  || `${files.length} files`;
    const batchLabel = opts.batchName || name;
    const total      = files.length;

    const job = {
      id:        jobId,
      type:      'upload',
      name,
      projectId,
      fileCount: total,
      status:    'running',
      progress:  0,
      batchId:   null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error:     null,
    };
    upsert(job);

    const notifyId = (typeof Notify !== 'undefined')
      ? Notify.progress(`Uploading ${name}`, `0% — 0 / ${total} files`, 0)
      : null;

    // Chunk the file list
    const chunks = [];
    for (let i = 0; i < files.length; i += CHUNK) chunks.push(files.slice(i, i + CHUNK));

    let uploadedCount = 0;
    let batchId       = null;

    function uploadChunk(index) {
      if (index >= chunks.length) {
        // All done
        const updated = { ...get(jobId), status: 'done', progress: 100, batchId, updatedAt: new Date().toISOString() };
        upsert(updated);
        if (notifyId) Notify.promoteCompleted(notifyId, true, `${name} uploaded`);
        if (typeof opts.onDone === 'function') opts.onDone({ batchId });
        return;
      }

      const chunk = chunks[index];
      const fd    = new FormData();
      fd.append('projectId', projectId);
      fd.append('batchName', batchLabel);
      if (batchId) fd.append('batchId', batchId);
      chunk.forEach(f => fd.append('images', f));

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/images/upload');
      xhr.withCredentials = true;

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        // Overall progress = completed chunks + partial current chunk
        const chunkFrac = e.loaded / e.total;
        const overall   = Math.round(((uploadedCount + chunk.length * chunkFrac) / total) * 100);
        const current   = get(jobId);
        if (current) upsert({ ...current, progress: overall, updatedAt: new Date().toISOString() });
        if (notifyId) Notify.updateProgress(notifyId, overall, `${overall}% — ${uploadedCount} / ${total} files`);
        if (typeof opts.onProgress === 'function') opts.onProgress(overall);
      };

      xhr.onload = () => {
        let resp = null;
        try { resp = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          if (resp?.batchId) batchId = resp.batchId;
          uploadedCount += chunk.length;
          uploadChunk(index + 1);
        } else {
          const errMsg = resp?.error || `Server error ${xhr.status}`;
          const updated = { ...get(jobId), status: 'error', error: errMsg, updatedAt: new Date().toISOString() };
          upsert(updated);
          if (notifyId) Notify.promoteCompleted(notifyId, false, `Upload failed: ${errMsg}`);
          if (typeof opts.onError === 'function') opts.onError(errMsg);
        }
      };

      xhr.onerror = () => {
        const updated = { ...get(jobId), status: 'error', error: 'Network error', updatedAt: new Date().toISOString() };
        upsert(updated);
        if (notifyId) Notify.promoteCompleted(notifyId, false, 'Upload failed: network error');
        if (typeof opts.onError === 'function') opts.onError('Network error');
      };

      xhr.send(fd);
    }

    uploadChunk(0);
    return jobId;
  }

  return { getAll, get, upload, uploadModel, uploadChunked, clearCompleted, clearAll };
})();
