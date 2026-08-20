const fs = require('fs');
const { dataPath, readJson } = require('./data-store');

// Asset requests can arrive by the thousands on a project grid. Cache read-only
// authorization indexes until the backing JSON file's metadata changes.
const accessCache = new Map();
function readAccessData(filename) {
  const target = dataPath(filename);
  let signature = 'missing';
  try {
    const stat = fs.statSync(target);
    signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch {}
  const cached = accessCache.get(target);
  if (cached?.signature === signature) return cached.value;
  const value = readJson(target);
  accessCache.set(target, { signature, value });
  return value;
}

function getProject(projectId) {
  return readAccessData('projects.json').find(project => project.id === projectId) || null;
}

function getImage(imageId) {
  return readAccessData('images.json').find(image => image.id === imageId) || null;
}

function imageForFilename(filename) {
  return readAccessData('images.json').find(image => image.filename === filename) || null;
}

function getModel(modelId) {
  return readAccessData('models.json').find(model => model.id === modelId) || null;
}

function modelForFilename(filename) {
  return readAccessData('models.json').find(model =>
    model.filename === filename || model.yamlFilename === filename
  ) || null;
}

function isProjectOwner(project, userId) {
  return Boolean(project && userId && project.userId === userId);
}

function isProjectMember(project, userId) {
  if (!project || !userId) return false;
  return isProjectOwner(project, userId) ||
    (project.collaborators || []).some(collaborator => collaborator.userId === userId);
}

function projectMember(project, userId) {
  if (!isProjectMember(project, userId)) return null;
  if (project.userId === userId) {
    const user = readAccessData('users.json').find(candidate => candidate.id === userId);
    return { userId, username: user?.username || 'Project owner', role: 'owner' };
  }
  const collaborator = (project.collaborators || []).find(candidate => candidate.userId === userId);
  return { ...collaborator, role: 'collaborator' };
}

function projectForImage(imageId) {
  const image = getImage(imageId);
  if (!image) return { image: null, project: null };
  return { image, project: getProject(image.projectId) };
}

function canAccessImage(imageId, userId) {
  const { image, project } = projectForImage(imageId);
  return Boolean(image && isProjectMember(project, userId));
}

function canAccessModel(model, userId, projectId = model?.projectId) {
  if (!model || !projectId || model.projectId !== projectId) return false;
  const project = getProject(projectId);
  if (isProjectOwner(project, userId) || model.userId === userId) return true;
  return model.sharedWithCollaborators === true && isProjectMember(project, userId);
}

function datasetForFilename(filename) {
  return readAccessData('datasets.json').find(dataset =>
    (dataset.images || []).some(image => image.filename === filename)
  ) || null;
}

function canAccessDataset(dataset, userId) {
  if (!dataset || !userId) return false;
  if (dataset.userId === userId) return true;
  if (!dataset.sharedWithCollaborators) return false;
  const shareProjectId = dataset.sourceProjectId || dataset.shareProjectId;
  if (!shareProjectId) return false;
  return isProjectMember(getProject(shareProjectId), userId);
}

function denyMissingOrForbidden(res, object, allowed, label) {
  if (!object) {
    res.status(404).json({ error: `${label} not found.` });
    return true;
  }
  if (!allowed) {
    res.status(403).json({ error: `No access to this ${label.toLowerCase()}.` });
    return true;
  }
  return false;
}

module.exports = {
  getProject,
  getImage,
  imageForFilename,
  getModel,
  modelForFilename,
  isProjectOwner,
  isProjectMember,
  projectMember,
  projectForImage,
  canAccessImage,
  canAccessModel,
  datasetForFilename,
  canAccessDataset,
  denyMissingOrForbidden,
};
