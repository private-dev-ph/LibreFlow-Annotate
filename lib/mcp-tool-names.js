'use strict';

// Static catalog shared by the isolated bridge and the application. No storage imports.
const TOOL_NAMES = Object.freeze([
  'libreflow_preview_inference',
  'libreflow_start_inference',
  'libreflow_get_inference_draft',
  'libreflow_propose_annotations',
  'libreflow_apply_annotation_proposal',
  'libreflow_preview_version',
  'libreflow_create_version',
  'libreflow_preview_export',
  'libreflow_export_version',
  'libreflow_get_job',
  'libreflow_cancel_job',
  'libreflow_get_operation',
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
