'use strict';

// Static catalog shared by the isolated bridge and the application. No storage imports.
const TOOL_NAMES = Object.freeze([
  'libreflow_list_projects',
  'libreflow_get_project',
  'libreflow_list_images',
  'libreflow_list_batches',
  'libreflow_get_annotations',
  'libreflow_get_image_preview',
  'libreflow_list_models',
  'libreflow_get_model_classes',
  'libreflow_list_versions',
  'libreflow_get_version',
  'libreflow_get_dataset_health',
]);

module.exports = { TOOL_NAMES };
