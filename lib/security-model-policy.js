const path = require('path');

function isPyTorchPickleModel(modelOrFormat) {
  if (typeof modelOrFormat === 'string') {
    const value = modelOrFormat.trim().toLowerCase();
    return ['pt', 'pth'].includes(value.replace(/^\./, '')) || ['.pt', '.pth'].includes(path.extname(value));
  }
  if (!modelOrFormat || typeof modelOrFormat !== 'object') return false;
  const model = modelOrFormat;
  return [model.format, model.originalName, model.filename]
    .some(value => typeof value === 'string' && isPyTorchPickleModel(value));
}

function shouldBlockPyTorchModel(modelOrFormat, env = process.env) {
  return env.NODE_ENV === 'production' && isPyTorchPickleModel(modelOrFormat);
}

module.exports = { isPyTorchPickleModel, shouldBlockPyTorchModel };
