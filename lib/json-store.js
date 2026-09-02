const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

function dataDirectory() {
  return path.resolve(process.env.LIBREFLOW_DATA_DIR || path.join(ROOT_DIR, 'data'));
}

function dataFile(name) {
  return path.join(dataDirectory(), name);
}

function readJson(filePath, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return typeof fallback === 'function' ? fallback() : structuredClone(fallback);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    // Windows cannot always replace an existing file with renameSync.
    if (!fs.existsSync(filePath)) throw error;
    fs.copyFileSync(tempPath, filePath);
    fs.unlinkSync(tempPath);
  }
}

function updateJson(filePath, fallback, updater) {
  const current = readJson(filePath, fallback);
  const next = updater(current);
  writeJson(filePath, next === undefined ? current : next);
  return next === undefined ? current : next;
}

function createCollectionStore(filename) {
  const filePath = dataFile(filename);
  return {
    filePath,
    read: () => readJson(filePath, []),
    write: value => writeJson(filePath, value),
    update: updater => updateJson(filePath, [], updater),
  };
}

module.exports = {
  ROOT_DIR,
  dataDirectory,
  dataFile,
  readJson,
  writeJson,
  updateJson,
  createCollectionStore,
};
