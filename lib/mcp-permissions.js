'use strict';

const READ_SCOPES = Object.freeze([
  'mcp:projects:read', 'mcp:annotations:read', 'mcp:images:preview',
  'mcp:models:read', 'mcp:versions:read',
]);
const ACTION_SCOPES = Object.freeze([
  'mcp:images:read', 'mcp:inference:run', 'mcp:annotations:append',
  'mcp:versions:create', 'mcp:exports:create', 'mcp:jobs:read', 'mcp:jobs:cancel',
]);
const SCOPES = Object.freeze([...READ_SCOPES, ...ACTION_SCOPES]);
const SCOPE_METADATA = Object.freeze({
  'mcp:projects:read': { label: 'Project and image information', description: 'Names, labels, dimensions, batches, and counts in your selected projects.', required: true, group: 'Read information' },
  'mcp:annotations:read': { label: 'Annotation content', description: 'Read annotation labels and geometry.', group: 'Read information' },
  'mcp:images:preview': { label: 'Image previews', description: 'Share reduced-size images and crops with the connected AI service.', group: 'Read information' },
  'mcp:models:read': { label: 'Models and classes', description: 'Read accessible model names, formats, and detection class IDs. Model weights stay private.', group: 'Read information' },
  'mcp:versions:read': { label: 'Versions and health', description: 'Read version settings, split counts, and dataset health.', group: 'Read information' },
  'mcp:images:read': { label: 'Original images in exports', description: 'Allow original image files to be included in an approved dataset export.', group: 'Share files' },
  'mcp:inference:run': { label: 'Run inference into drafts', description: 'Request inference with your selected classes and tiling settings. You approve the run and review results before saving annotations.', group: 'Request actions', action: true, requires: ['mcp:models:read', 'mcp:annotations:read', 'mcp:jobs:read'] },
  'mcp:annotations:append': { label: 'Add annotations after approval', description: 'Propose additions for you to review. Existing annotations are preserved; changed images require a new proposal.', group: 'Request actions', action: true, requires: ['mcp:annotations:read'] },
  'mcp:versions:create': { label: 'Create dataset versions', description: 'Request versions with frozen image selections, splits, preprocessing, and augmentation. Each build needs your approval.', group: 'Request actions', action: true, requires: ['mcp:versions:read', 'mcp:annotations:read', 'mcp:jobs:read'] },
  'mcp:exports:create': { label: 'Export dataset versions', description: 'Request a format and ZIP options. Each export needs your approval before files can be downloaded.', group: 'Request actions', action: true, requires: ['mcp:versions:read', 'mcp:annotations:read', 'mcp:jobs:read'] },
  'mcp:jobs:read': { label: 'Monitor requested jobs', description: 'View progress and results only for jobs started through this connection.', group: 'Manage jobs' },
  'mcp:jobs:cancel': { label: 'Cancel requested jobs', description: 'Stop pending work started through this connection. Completed work remains available.', group: 'Manage jobs', action: true, requires: ['mcp:jobs:read'] },
});

function writesEnabled(env = process.env) { return env.LIBREFLOW_MCP_WRITES_ENABLED === 'true'; }
function scopeMetadata() {
  return SCOPES.map(id => ({ id, required: false, requires: [], ...SCOPE_METADATA[id] }));
}
function validateScopeDependencies(scopes) {
  for (const scope of scopes) {
    for (const required of SCOPE_METADATA[scope]?.requires || []) {
      if (!scopes.includes(required)) {
        throw Object.assign(new Error(`${SCOPE_METADATA[scope].label} also requires ${SCOPE_METADATA[required].label}.`), { status: 400, code: 'DEPENDENT_SCOPE_REQUIRED' });
      }
    }
  }
}
module.exports = { SCOPES, READ_SCOPES, ACTION_SCOPES, SCOPE_METADATA, scopeMetadata, writesEnabled, validateScopeDependencies };
