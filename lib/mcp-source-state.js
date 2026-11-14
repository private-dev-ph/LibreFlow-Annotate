'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { dataFile } = require('./json-store');
const { readJsonByKey } = require('./read-index');
const { uploadsDir } = require('./data-store');

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function conflict(message = 'The image changed. Create a new proposal before continuing.') {
  return Object.assign(new Error(message), { status: 409, code: 'SOURCE_CHANGED' });
}
function imageState(projectId, imageId) {
  const images = readJsonByKey(dataFile('images.json'), 'id', imageId);
  const image = images.find(item => item.id === imageId && item.projectId === projectId);
  const project = readJsonByKey(dataFile('projects.json'), 'id', projectId).find(item => item.id === projectId);
  if (!image || !project) throw Object.assign(new Error('Image not found.'), { status: 404, code: 'NOT_FOUND' });
  const annotations = readJsonByKey(dataFile('annotations.json'), 'imageId', imageId).filter(item => item.imageId === imageId);
  const review = readJsonByKey(dataFile('reviews.json'), 'imageId', imageId).find(item => item.imageId === imageId) || null;
  const revision = digest({ image, annotations: [...annotations].sort((a,b) => String(a.id).localeCompare(String(b.id))), review, labels: project.labelClasses || [] });
  return { image, annotations, project, revision };
}
function hasStoredDimensions(image) {
  return Number.isSafeInteger(image?.width) && Number.isSafeInteger(image?.height) && image.width > 0 && image.height > 0;
}
async function imageStateWithDimensions(projectId, imageId) {
  const initial = imageState(projectId, imageId);
  if (hasStoredDimensions(initial.image)) return { ...initial, image: { ...initial.image } };
  const initialStamp = fileStamp(initial.image);
  const dimensions = await require('./mcp-image-metadata').resolveImageDimensions(initial.image);
  const latest = imageState(projectId, imageId);
  if (latest.revision !== initial.revision || stable(fileStamp(latest.image)) !== stable(initialStamp)) throw conflict();
  return { ...latest, image: { ...latest.image, ...dimensions } };
}
function sourceFile(image) {
  if (typeof image.filename !== 'string' || path.basename(image.filename) !== image.filename || /[\\/]/.test(image.filename)) throw conflict('The source image file is unavailable.');
  const root = fs.realpathSync(uploadsDir());
  const file = path.join(root, image.filename);
  if (fs.lstatSync(file).isSymbolicLink()) throw conflict('The source image file is unavailable.');
  const real = fs.realpathSync(file);
  if (path.dirname(real) !== root || !fs.statSync(real).isFile()) throw conflict('The source image file is unavailable.');
  return real;
}
function fileStamp(image) {
  const stat = fs.statSync(sourceFile(image));
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function frozenImage(projectId, imageId) {
  const state = imageState(projectId, imageId);
  return { imageId, revision: state.revision, file: fileStamp(state.image) };
}
function assertFrozenImages(projectId, frozen) {
  for (const item of frozen) {
    const state = imageState(projectId, item.imageId);
    if (state.revision !== item.revision || stable(fileStamp(state.image)) !== stable(item.file)) throw conflict();
  }
}
module.exports = { stable, digest, conflict, imageState, imageStateWithDimensions, sourceFile, fileStamp, frozenImage, assertFrozenImages };
