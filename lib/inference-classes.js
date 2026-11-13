// Shared contract for explicit detection-class selection.
function normalizeClassIds(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || value.length > 10000 ||
      value.some(id => !Number.isSafeInteger(id) || id < 0)) {
    throw new Error('Choose at least one valid model class.');
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

function validateClassSelectionResponse(data, classIds) {
  if (classIds === null) return;
  const acknowledged = data?.class_ids;
  if (!Array.isArray(acknowledged) || acknowledged.length !== classIds.length ||
      acknowledged.some(id => !Number.isSafeInteger(id)) ||
      new Set(acknowledged).size !== classIds.length ||
      !classIds.every(id => acknowledged.includes(id))) {
    throw new Error('The inference server did not confirm the selected classes. Update the inference server and try again.');
  }
  if (!Array.isArray(data.results) || data.results.some(item => !classIds.includes(item?.class_id))) {
    throw new Error('The inference server returned detections outside the selected classes. No annotations were added.');
  }
}

module.exports = { normalizeClassIds, validateClassSelectionResponse };
