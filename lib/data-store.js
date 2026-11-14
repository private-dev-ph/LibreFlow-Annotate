const fs = require('fs');
const path = require('path');
const { notifyJsonChange } = require('./json-changes');
const {
  assertDataReadable,
  dataDirectory,
  readStagedJson,
  writeJsonBytes,
} = require('./data-command');

const APP_ROOT = path.join(__dirname, '..');

function dataDir() {
  return dataDirectory();
}

function dataPath(filename) {
  return path.join(dataDir(), filename);
}

function uploadsDir() {
  return process.env.LIBREFLOW_UPLOADS_DIR || path.join(APP_ROOT, 'uploads');
}

function modelsDir() {
  return process.env.LIBREFLOW_MODELS_DIR || path.join(APP_ROOT, 'models');
}

function readJson(file, fallback = []) {
  const target = path.isAbsolute(file) ? file : dataPath(file);
  assertDataReadable(target);
  const staged = readStagedJson(target);
  if (staged.found) return staged.value;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

function writeJson(file, value) {
  const target = path.isAbsolute(file) ? file : dataPath(file);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return writeJsonBytes(target, bytes, { legacyWriter: writeLegacyBytes });
}

function writeLegacyBytes(target, bytes) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  } finally {
    notifyJsonChange(target);
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  APP_ROOT,
  dataDir,
  dataPath,
  uploadsDir,
  modelsDir,
  readJson,
  writeJson,
  deepClone,
};
