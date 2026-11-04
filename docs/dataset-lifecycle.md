# Dataset lifecycle API

LibreFlow's lifecycle API adds immutable, reproducible dataset snapshots, dataset-health reports, and validated imports of already-annotated data. Every endpoint requires the existing authenticated session and enforces project or dataset access.

The UI is available at:

```text
/dataset-lifecycle?sourceType=project&sourceId=<project-id>
/dataset-lifecycle?sourceType=dataset&sourceId=<dataset-id>
```

Project and dataset pages link to it directly.

## Project Versions tab

The project page also has a **Versions** tab (`/project?projectId=<id>#versions`). Its builder includes annotated images, explicitly marked backgrounds, and images marked completed/submitted/approved. Untouched uploads are excluded by default; select **Include unfinished uploads as null images** to save them in the snapshot. Version names are optional: blank or whitespace-only names become **Version 1**, **Version 2**, and so on. Originals, annotations and existing versions are never rewritten.

Use the two handles to set the train/valid and valid/test boundaries, or type any of the three percentages. Editing one percentage distributes the remainder proportionally between the other two; the total remains 100%. Keyboard arrow keys work on both handles. **Check image counts** computes actual source assignments after tag/class/background filtering; exact duplicate images remain together, so small datasets may not exactly match the percentages.

Splits are assigned **before** preprocessing and augmentation. Tiles and isolated objects inherit their source split. Augmentation and mosaic sources use training images only. The history shows both source and final counts. Identical generated variants with identical labels are skipped.

Preprocessing supports auto-orientation, percentage static crop, object isolation into classification crops, grayscale, class rename/merge/omission, tag requirements/exclusions, and a maximum background-image share. Resizing supports stretch, center crop, fit within, and reflected/black/white padding. Tiling runs before resizing and supports a grid, fixed pixel size, or fixed aspect ratio with overlap and padding. Contrast supports percentile stretching, histogram equalization, and adaptive equalization (CLAHE). Explicit fixed/aspect tiles cannot be combined with object isolation.

Image augmentation supports horizontal/vertical flips, quarter-turns, random crop, arbitrary rotation, shear, grayscale, hue, saturation, brightness, exposure, blur, salt-and-pepper noise, camera gain, motion blur, cutout and mosaic. Bounding-box settings support the documented geometric and lighting/noise operations. Geometric box-only operations cannot safely coexist with intersecting non-box spatial labels; use image-level operations for those images. Settings are stored with the immutable version, together with sampled transformation provenance and source IDs.

Each preprocessing and augmentation control has a **Preview effect** button. It samples the first readable image in the project, applies only that operation using its current values, and shows the original and processed images with annotation outlines. Previewing an unchecked effect does not enable it for version creation. Filters report whether the sample remains included; class changes show the original and resulting label names. Tiles and isolated objects show up to six outputs. Random effects use the augmentation seed. Previews are generated in temporary storage, capped at 32 megapixels, and never save a version or modify source data.

**Export dataset** opens a format dialog offering YOLO TXT, Roboflow YOLO, COCO JSON, Pascal VOC XML, and CSV. **Include images in ZIP** controls all pixel files, including classification copies. **Include unannotated images as null images to dataset** includes unannotated images already saved in that version; explicitly marked backgrounds are retained regardless. It never adds later project uploads to an immutable version. To export unfinished uploads, include them when creating the version.

Exports retain split folders, lossless LibreFlow annotation metadata, the unchanged original `manifest.json` and checksums. `export-manifest.json` identifies the selected subset and its counts separately from the original snapshot. Object-isolation output also includes `classification/<split>/<class-folder>/`, with `classification/classes.json` mapping folder names back to labels. No model training service or paid augmentation feature is required.

`GET .../versions/:versionId/download?format=roboflow&images=true&includeNull=false` accepts the five formats above. Omitting `format` preserves the complete legacy archive. `POST .../versions/sample-preview` accepts `{operation, processing, seed}` and requires the same source access and `versions:read` scope as other previews; it returns PNG thumbnails and geometry, without persisted files.

The controls follow these reference option families; this is an independent implementation, not a claim of byte-identical output to Roboflow:

- [Image preprocessing reference](https://docs.roboflow.com/datasets/versions/dataset-versions/image-preprocessing)
- [Image augmentation reference](https://docs.roboflow.com/datasets/versions/dataset-versions/image-augmentation)

To preview a project version, `POST /api/dataset-lifecycle/project/:projectId/versions/preview` accepts the same selection, processing and split settings as creation. It returns selected/excluded counts, classes, tags and source split counts, without creating a version. Send `selection: "annotated"` and `preserveExistingSplits: false` to match the new tab. Existing API clients may retain `selection: "all"` and imported split assignments.

## Immutable versions

Create a version:

```http
POST /api/dataset-lifecycle/project/:projectId/versions
Content-Type: application/json

{
  "name": "v1-baseline",
  "description": "Reviewed baseline",
  "splitRatios": { "train": 70, "valid": 20, "test": 10 },
  "seed": "release-1",
  "preserveExistingSplits": true,
  "reproducibility": {
    "gitCommit": "abc123",
    "training": { "framework": "ultralytics", "imageSize": 640 }
  },
  "processing": {
    "preprocessing": {
      "autoOrient": true,
      "grayscale": false,
      "resize": { "enabled": true, "width": 640, "height": 640, "mode": "letterbox", "background": "#000000" },
      "crop": { "enabled": false, "x": 0, "y": 0, "width": 640, "height": 640 },
      "tile": { "enabled": false, "width": 640, "height": 640, "overlap": 64 }
    },
    "augmentation": {
      "count": 1,
      "seed": "augmentation-release-1",
      "horizontalFlip": 0.5,
      "verticalFlip": 0,
      "rotate": [0, 90, 180, 270],
      "brightness": { "enabled": true, "min": 0.85, "max": 1.15 },
      "noise": { "enabled": true, "probability": 0.25, "sigma": 8 }
    }
  }
}
```

Ratios may be fractions or percentages; they are normalized. Assignment is deterministic from the seed and content hash. Exact duplicates and generated derivatives share one split. Transformations are materialized into PNG snapshot assets and annotation geometry is resized, clipped, flipped, or rotated with the pixels. Each output image records its source image, transformations, and augmentation variant in `lineage`.

Other version endpoints:

```text
GET /api/dataset-lifecycle/:sourceType/:sourceId/versions
GET /api/dataset-lifecycle/:sourceType/:sourceId/versions/:versionId
GET /api/dataset-lifecycle/:sourceType/:sourceId/versions/:versionId?includeAnnotations=false
GET /api/dataset-lifecycle/:sourceType/:sourceId/versions/:versionId/download
```

`sourceType` is `project` or `dataset`. There are deliberately no update or delete endpoints. Snapshot image files are addressed by SHA-256. The manifest has a content hash and a separate manifest hash. The default download includes the manifest, internal annotations, COCO JSON, ready-to-train YOLO split folders and labels, `data.yaml`, content-addressed snapshot images, and SHA-256 checksums. Format-specific downloads use the selected format and image options. Downloads re-check the manifest and each included snapshot asset before returning the ZIP; annotations-only downloads do not read image bytes.

## Dataset health

Analyze live data:

```text
GET /api/dataset-lifecycle/:sourceType/:sourceId/health
```

Analyze an immutable version:

```text
GET /api/dataset-lifecycle/:sourceType/:sourceId/health?versionId=<version-id>
```

Reports include:

- declared and observed class balance;
- empty/null rates;
- width, height, common-dimension, and aspect-ratio distributions;
- relative bounding-box size buckets;
- a 10×10 annotation-center heatmap;
- invalid, degenerate, and out-of-bounds geometry;
- exact duplicate groups by SHA-256;
- probable filename collisions; and
- exact-content leakage across train, valid, and test splits.

Live image hashes and dimensions are cached using file size and modification time. Version reports use only their immutable manifest.

## Annotated dataset import

Validate before writing anything:

```http
POST /api/dataset-lifecycle/projects/:projectId/import
Content-Type: multipart/form-data

dataset=<zip-or-coco-json>
dryRun=true
format=auto
conflictPolicy=merge
duplicatePolicy=skipExact
annotationConflict=append
classMapping={"incoming_name":"project_name","ignored_class":""}
```

Send the same request with `dryRun=false` to commit the validated plan. Supported sources are:

- YOLO detection and segmentation ZIPs, with classes from `data.yaml` or `classes.txt`;
- COCO JSON or ZIP, including polygon segmentation and bounding boxes; and
- Pascal VOC ZIP, including `ImageSets/Main` split files.

A standalone COCO JSON file attaches annotations to project images matched unambiguously by filename. Archives carry their own images and create an import batch. The dry run reports missing files, malformed rows, geometry problems, taxonomy actions, duplicate actions, split counts, warnings, and blocking errors.

Class conflict policies are `merge`, `rename`, `skip`, and `error`. Exact-image policies are `keep`, `skipExact`, and `error`. When standalone COCO annotations target an image that already has annotations, `annotationConflict` may be `append`, `replace`, or `skipExisting`.

Committed imports stage and verify image bytes before updating JSON indexes. If any index write fails, the original indexes are restored and staged image files are removed.
