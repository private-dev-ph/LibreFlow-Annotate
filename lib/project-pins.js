const { dataFile, readJson, writeJson } = require('./json-store');

const PINS_FILE = () => dataFile('project-pins.json');

function readPins() {
  const pins = readJson(PINS_FILE(), []);
  return Array.isArray(pins)
    ? pins.filter(pin => pin && typeof pin.userId === 'string' && typeof pin.projectId === 'string')
    : [];
}

function isPinned(userId, projectId) {
  return readPins().some(pin => pin.userId === userId && pin.projectId === projectId);
}

function setPinned(userId, projectId, pinned) {
  const pins = readPins().filter(pin => !(pin.userId === userId && pin.projectId === projectId));
  if (pinned) pins.push({ userId, projectId });
  writeJson(PINS_FILE(), pins);
  return pinned;
}

module.exports = { readPins, isPinned, setPinned };
