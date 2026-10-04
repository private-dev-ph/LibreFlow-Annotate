const path = require('path');

function isPyTorchPickleModel(modelOrFormat) {
  if (typeof modelOrFormat === 'string') {
    const value = modelOrFormat.trim().toLowerCase();
    return ['pt', 'pth'].includes(value.replace(/^\./, '')) || ['.pt', '.pth'].includes(path.extname(value));
  }
  const model = modelOrFormat || {};
  return [model.format, model.originalName, model.filename].some(isPyTorchPickleModel);
}

function shouldBlockPyTorchModel(modelOrFormat, env = process.env) {
  return env.NODE_ENV === 'production' && isPyTorchPickleModel(modelOrFormat);
}

module.exports = { isPyTorchPickleModel, shouldBlockPyTorchModel };
