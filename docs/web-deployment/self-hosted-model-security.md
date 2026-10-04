# Self-hosted model loading policy

In `NODE_ENV=production`, the Express upload route rejects `.pt` and `.pth` checkpoints in Multer's file filter, before the model bytes are written to disk. Production inference routes and queued inference also refuse those formats, including previously stored checkpoints and auxiliary classifier models. There is no production override. Local development keeps the existing `.pt`/`.pth` workflow so operators can continue using trusted local models.

PyTorch checkpoints commonly contain pickle data. Loading a checkpoint can execute code in the inference process; a filename or extension check cannot establish that a checkpoint is safe. Only load checkpoints from sources you trust, and keep the Python inference service bound to a private local interface that is not reachable from untrusted networks. Production self-hosted installations should use ONNX models where supported and keep the inference service private. The existing Python path-based service remains a trusted-local runtime boundary and is not made safe for arbitrary model files by this upload policy.

The hosted static application uses its separate local companion contract, which accepts validated ONNX model bytes and rejects `.pt`/`.pth`. This self-hosted development compatibility does not enable a bypass in the static client or companion.
