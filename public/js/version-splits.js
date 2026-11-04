(function (root) {
  'use strict';
  const clamp = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  function fromBoundaries(trainEnd, validEnd) {
    const train = clamp(trainEnd), end = Math.max(train, clamp(validEnd));
    return { train, valid: end - train, test: 100 - end };
  }
  function rebalance(current, changed, value) {
    const keys = ['train', 'valid', 'test'];
    if (!keys.includes(changed)) throw new Error('Unknown dataset split.');
    const next = { ...current, [changed]: clamp(value) };
    const others = keys.filter(key => key !== changed);
    const remaining = 100 - next[changed];
    const weight = Number(current[others[0]]) + Number(current[others[1]]);
    next[others[0]] = Math.round(remaining * (weight ? Number(current[others[0]]) / weight : 0.5));
    next[others[1]] = remaining - next[others[0]];
    return next;
  }
  const api = { fromBoundaries, rebalance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VersionSplits = api;
})(typeof window === 'undefined' ? globalThis : window);
