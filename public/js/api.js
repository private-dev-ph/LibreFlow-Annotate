// api.js – thin wrapper around fetch for the REST API

async function fetchLibraryPage(resource, parameters = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const response = await fetch(`/api/${resource}/browse?${query}`, { credentials: 'include' });
  const data = await response.json().catch(() => { throw new Error('The library response could not be read. Please retry.'); });
  if (!response.ok) throw new Error(data.error || `Could not load ${resource} (${response.status}).`);
  if (!Array.isArray(data.items) || !Number.isInteger(data.page) || !Number.isInteger(data.totalPages) || !Number.isInteger(data.total)) {
    throw new Error('The library response was invalid. Please retry.');
  }
  return data;
}

const API = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  async getMe() {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (!r.ok) return null;
    return r.json();
  },
  async logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  },

  // ── Projects ──────────────────────────────────────────────────────────────
  async getProjects() {
    const r = await fetch('/api/projects', { credentials: 'include' });
    return r.json();
  },
  async createProject(name, description) {
    const r = await fetch('/api/projects', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    return r.json();
  },
  async deleteProject(id) {
    const r = await fetch(`/api/projects/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to delete project.');
    }
    return r.json().catch(() => ({}));
  },
  async setProjectPin(id, pinned) {
    const r = await fetch(`/api/projects/${encodeURIComponent(id)}/pin`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Failed to update project pin.');
    return data;
  },
  async updateProject(id, data) {
    const r = await fetch(`/api/projects/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  },

  // ── Images ────────────────────────────────────────────────────────────────
  async browseProjectImages(projectId, parameters = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...parameters, projectId })) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const response = await fetch(`/api/images/browse?${query}`, { credentials: 'include' });
    const data = await response.json().catch(() => { throw new Error('The image response could not be read. Please retry.'); });
    if (!response.ok) throw new Error(data.error || `Could not load project images (${response.status}).`);
    if (!Array.isArray(data.groups) || !data.groups.every(group => Array.isArray(group.items))
        || !Number.isInteger(data.page) || !Number.isInteger(data.totalPages) || !Number.isInteger(data.total)
        || !Number.isInteger(data.projectTotal) || !Number.isInteger(data.scopeTotal)) {
      throw new Error('The image response was invalid. Please retry.');
    }
    return data;
  },
  async getImages(projectId) {
    const r = await fetch(`/api/images?projectId=${projectId}`, { credentials: 'include' });
    return r.json();
  },
  async getAllImages() {
    const r = await fetch('/api/images', { credentials: 'include' });
    return r.json();
  },
  async uploadImages(projectId, files) {
    const fd = new FormData();
    fd.append('projectId', projectId);
    for (const f of files) fd.append('images', f);
    const r = await fetch('/api/images/upload', { method: 'POST', credentials: 'include', body: fd });
    return r.json();
  },
  async deleteImage(id) {
    await fetch(`/api/images/${id}`, { method: 'DELETE', credentials: 'include' });
  },
  async updateImage(id, data) {
    const r = await fetch(`/api/images/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const response = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(response.error || 'Failed to update image.');
    return response;
  },

  // ── Annotations ───────────────────────────────────────────────────────────
  async getAnnotations(imageId) {
    const r = await fetch(`/api/annotations/${imageId}`, { credentials: 'include' });
    return r.json();
  },
  async saveAnnotations(imageId, shapes, metadata = {}) {
    const r = await fetch('/api/annotations', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageId, shapes, ...metadata }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to save annotations.');
    return data;
  },
  async getAnnotationRevisions(imageId, includeAnnotations = false) {
    const r = await fetch(`/api/annotations/${imageId}/revisions?includeAnnotations=${includeAnnotations}`, { credentials: 'include' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load annotation history.');
    return data;
  },
  async restoreAnnotationRevision(imageId, revisionId) {
    const r = await fetch(`/api/annotations/${imageId}/revisions/${revisionId}/restore`, {
      method: 'POST', credentials: 'include',
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to restore revision.');
    return data;
  },
  async relabelAnnotations(projectId, oldName, newName) {
    const r = await fetch('/api/annotations/rename-label', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, oldName, newName }),
    });
    return r.json();
  },
  exportUrl(projectId) {
    return `/api/annotations/export/${projectId}`;
  },

  // Review workflow
  async getImageReview(imageId) {
    const r = await fetch(`/api/reviews/image/${imageId}`, { credentials: 'include' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load review.');
    return data;
  },
  async updateImageReview(imageId, changes) {
    const r = await fetch(`/api/reviews/image/${imageId}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to update review.');
    return data;
  },
  async addReviewComment(imageId, message, kind = 'comment', annotationId = null) {
    const r = await fetch(`/api/reviews/image/${imageId}/comments`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, kind, annotationId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to add review note.');
    return data;
  },
  async resolveReviewIssue(imageId, issueId, resolved = true) {
    const r = await fetch(`/api/reviews/image/${imageId}/issues/${issueId}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to update issue.');
    return data;
  },
  async getProjectReviews(projectId, status = '', parameters = {}) {
    const params = new URLSearchParams({ ...(status ? { status } : {}), ...parameters });
    const query = params.toString() ? `?${params}` : '';
    const r = await fetch(`/api/reviews/project/${projectId}${query}`, { credentials: 'include' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load project reviews.');
    return data;
  },
  async getProjectAudit(projectId, limit = 200) {
    const r = await fetch(`/api/reviews/project/${projectId}/audit?limit=${limit}`, { credentials: 'include' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load audit history.');
    return data;
  },

  // ── Models ───────────────────────────────────────────────────────────────
  async getModels(projectId) {
    const r = await fetch(`/api/models?projectId=${projectId}`, { credentials: 'include' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load models.');
    return data;
  },
  async getAvailableModels(projectId) {
    const r = await fetch(`/api/models/available?projectId=${encodeURIComponent(projectId)}`, { credentials: 'include' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load available models.');
    return data;
  },
  async copyModel(id, projectId) {
    const r = await fetch(`/api/models/${encodeURIComponent(id)}/copy`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to add model to project.');
    return data;
  },
  async deleteModel(id) {
    const r = await fetch(`/api/models/${id}`, { method: 'DELETE', credentials: 'include' });
    return r.json();
  },
  async patchModel(id, data) {
    const r = await fetch(`/api/models/${id}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  },

  // ── Batches ───────────────────────────────────────────────────────────────
  browseBatches(projectId, parameters = {}) {
    return fetchLibraryPage('batches', { ...parameters, projectId });
  },
  browseSubBatches(batchId, parameters = {}) {
    return fetchLibraryPage(`batches/${encodeURIComponent(batchId)}/subbatches`, parameters);
  },
  async getBatchCatalog(projectId) {
    const response = await fetch(`/api/batches/catalog?${new URLSearchParams({ projectId })}`, { credentials: 'include' });
    const data = await response.json().catch(() => { throw new Error('The batch catalog could not be read. Please retry.'); });
    if (!response.ok) throw new Error(data.error || 'Could not load batch choices.');
    if (!Array.isArray(data.items)) throw new Error('The batch catalog was invalid. Please retry.');
    return data.items;
  },
  async getBatches(projectId) {
    const r = await fetch(`/api/batches?projectId=${projectId}`, { credentials: 'include' });
    return r.json();
  },
  async patchBatch(batchId, data) {
    const r = await fetch(`/api/batches/${batchId}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  },
  async splitBatch(batchId, data) {
    const r = await fetch(`/api/batches/${batchId}/split`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  },
  async patchSubBatch(batchId, subId, data) {
    const r = await fetch(`/api/batches/${batchId}/subbatches/${subId}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  },
  async deleteBatch(batchId) {
    const r = await fetch(`/api/batches/${batchId}`, { method: 'DELETE', credentials: 'include' });
    return r.json();
  },

  // ── Collaborators ─────────────────────────────────────────────────────────
  async lookupUser(username) {
    const r = await fetch(`/api/auth/lookup?username=${encodeURIComponent(username)}`, { credentials: 'include' });
    return r.json();  // { id, username } or { error }
  },
  async addCollaborator(projectId, userId, username) {
    const r = await fetch(`/api/projects/${projectId}/collaborators`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, username }),
    });
    return r.json();
  },
  async removeCollaborator(projectId, userId) {
    const r = await fetch(`/api/projects/${projectId}/collaborators/${userId}`, {
      method: 'DELETE', credentials: 'include',
    });
    return r.json();
  },

  // ── Notifications ────────────────────────────────────────────────────
  async getNotifications() {
    const r = await fetch('/api/notifications', { credentials: 'include' });
    return r.json();
  },
  async markNotificationRead(id) {
    const r = await fetch(`/api/notifications/${id}/read`, {
      method: 'PATCH', credentials: 'include',
    });
    return r.json();
  },
  async markAllNotificationsRead() {
    const r = await fetch('/api/notifications/read-all', {
      method: 'POST', credentials: 'include',
    });
    return r.json();
  },

  browseDatasets(parameters = {}) { return fetchLibraryPage('datasets', parameters); },
  async browseDatasetImages(id, parameters = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const response = await fetch(`/api/datasets/${encodeURIComponent(id)}/images/browse?${query}`, { credentials: 'include' });
    const data = await response.json().catch(() => { throw new Error('The image response could not be read. Please retry.'); });
    if (!response.ok) throw new Error(data.error || `Could not load dataset images (${response.status}).`);
    if (!data.dataset || !Array.isArray(data.groups) || !data.groups.every(group => Array.isArray(group.items))
        || !Number.isInteger(data.page) || !Number.isInteger(data.totalPages) || !Number.isInteger(data.total)) {
      throw new Error('The image response was invalid. Please retry.');
    }
    return data;
  },
  browseModels(parameters = {}) { return fetchLibraryPage('models', parameters); },

  // ── Datasets ─────────────────────────────────────────────────────────────
  async getDatasets() {
    const r = await fetch('/api/datasets', { credentials: 'include' });
    return r.json();
  },
  async getDataset(id) {
    const r = await fetch(`/api/datasets/${id}`, { credentials: 'include' });
    return r.json();
  },
  async exportDatasetFromProject(projectId, payload = {}) {
    const r = await fetch('/api/datasets/export-from-project', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...payload }),
    });
    return r.json();
  },
  async uploadDataset(formData) {
    const r = await fetch('/api/datasets/upload', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    return r.json();
  },
  async patchDataset(id, data) {
    const r = await fetch(`/api/datasets/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  },
  async deleteDataset(id) {
    const r = await fetch(`/api/datasets/${id}`, { method: 'DELETE', credentials: 'include' });
    return r.json();
  },
  async importDatasetToProject(id, projectId, includeTags = true) {
    const r = await fetch(`/api/datasets/${id}/import`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, includeTags }),
    });
    return r.json();
  },
  async patchDatasetImage(datasetId, imageId, data) {
    const r = await fetch(`/api/datasets/${datasetId}/images/${imageId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  },
  async deleteDatasetImage(datasetId, imageId) {
    const r = await fetch(`/api/datasets/${datasetId}/images/${imageId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return r.json();
  },
};
