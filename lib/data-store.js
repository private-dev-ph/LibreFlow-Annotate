const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');

function dataDir() {
  return process.env.LIBREFLOW_DATA_DIR || path.join(APP_ROOT, 'data');
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
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const target = path.isAbsolute(file) ? file : dataPath(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
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
