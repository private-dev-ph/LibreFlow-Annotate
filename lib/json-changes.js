const { EventEmitter } = require('events');
const path = require('path');

const changes = new EventEmitter();

function notifyJsonChange(filePath) {
  changes.emit('write', path.resolve(filePath));
}

function onJsonChange(listener) {
  changes.on('write', listener);
  return () => changes.off('write', listener);
}

module.exports = {
  notifyJsonChange,
  onJsonChange,
};
