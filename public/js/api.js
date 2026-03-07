// api.js – thin wrapper around fetch for the REST API

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
    await fetch(`/api/projects/${id}`, { method: 'DELETE', credentials: 'include' });
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
    return r.json();
  },

  // ── Annotations ───────────────────────────────────────────────────────────
  async getAnnotations(imageId) {
    const r = await fetch(`/api/annotations/${imageId}`, { credentials: 'include' });
    return r.json();
  },
  async saveAnnotations(imageId, shapes) {
    const r = await fetch('/api/annotations', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageId, shapes }),
    });
    return r.json();
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

  // ── Models ───────────────────────────────────────────────────────────────
  async getModels(projectId) {
    const r = await fetch(`/api/models?projectId=${projectId}`, { credentials: 'include' });
    return r.json();
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
};
