const { dataFile, readJson } = require('./json-store');

function readProjects() {
  return readJson(dataFile('projects.json'), []);
}

function getProject(projectId) {
  return readProjects().find(project => project.id === projectId) || null;
}

function canAccessProject(projectId, userId) {
  const project = getProject(projectId);
  if (!project || !userId) return false;
  return project.userId === userId || (project.collaborators || []).some(member => member.userId === userId);
}

function ownsProject(projectId, userId) {
  return getProject(projectId)?.userId === userId;
}

function apiKeyAllowsProject(authContext, projectId) {
  if (!authContext || authContext.type !== 'api_key') return true;
  const allowed = authContext.projectIds || [];
  return allowed.length === 0 || allowed.includes(projectId);
}

module.exports = { readProjects, getProject, canAccessProject, ownsProject, apiKeyAllowsProject };
