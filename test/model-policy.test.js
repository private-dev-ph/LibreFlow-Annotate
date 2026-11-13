const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPyTorchPickleModel, shouldBlockPyTorchModel } = require('../lib/security-model-policy');

test('partial and empty model metadata terminates without recursion', () => {
  for (const value of [undefined, null, {}, { filename: 'detector.onnx' }, { format: 'onnx' }, { originalName: 'Detector.ONNX' }, { format: {} }]) {
    assert.equal(isPyTorchPickleModel(value), false);
    assert.equal(shouldBlockPyTorchModel(value, { NODE_ENV: 'production' }), false);
  }
});
test('every available model identity still blocks PyTorch in production', () => {
  for (const value of ['.PT', 'pth', { filename: 'detector.pt' }, { originalName: 'weights.PTH' }, { format: 'pt' }]) {
    assert.equal(shouldBlockPyTorchModel(value, { NODE_ENV: 'production' }), true);
    assert.equal(shouldBlockPyTorchModel(value, { NODE_ENV: 'development' }), false);
  }
});
