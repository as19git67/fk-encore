import os
from fastapi import FastAPI, UploadFile, File, HTTPException
import numpy as np


def _onnx_intra_op_threads() -> int:
    """Number of intra-op threads to hand to ONNX Runtime.

    ORT otherwise queries `std::thread::hardware_concurrency()`, which
    reports the full host topology — not the cpuset-restricted view
    the container actually runs under. It then tries to pin each
    worker thread to a logical CPU index and fails with
    `pthread_setaffinity_np failed … mask: {14, }` (EINVAL) for any
    index outside the cpuset. Reading `sched_getaffinity` gives the
    actually-allowed CPU count, and supplying *any* explicit
    `intra_op_num_threads` value silences ORT's automatic pinning.
    """
    override = os.environ.get("ORT_INTRA_OP_NUM_THREADS")
    if override:
        return max(1, int(override))
    if hasattr(os, "sched_getaffinity"):
        return max(1, len(os.sched_getaffinity(0)))
    return max(1, os.cpu_count() or 1)


def _install_ort_thread_cap() -> None:
    """Monkey-patch `onnxruntime.InferenceSession` so InsightFace's
    internal session construction picks up explicit SessionOptions.

    InsightFace's model_zoo builds `InferenceSession(path, providers=…)`
    without a `sess_options` argument, so this is the only handle we
    have to set `intra_op_num_threads`. The patch is a no-op when the
    caller already supplies its own SessionOptions.

    Idempotent — re-installing won't stack patches.
    """
    try:
        import onnxruntime as ort  # type: ignore
    except ImportError:
        # Tests stub `insightface` and `cv2` but not `onnxruntime`.
        # Production always has the real package via requirements.txt.
        return

    if getattr(ort.InferenceSession.__init__, "_fk_ort_thread_cap", False):
        return

    threads = _onnx_intra_op_threads()
    orig_init = ort.InferenceSession.__init__

    def patched_init(self, path_or_bytes, sess_options=None, *args, **kwargs):
        if sess_options is None:
            sess_options = ort.SessionOptions()
            sess_options.intra_op_num_threads = threads
            sess_options.inter_op_num_threads = 1
        return orig_init(self, path_or_bytes, sess_options, *args, **kwargs)

    patched_init._fk_ort_thread_cap = True  # type: ignore[attr-defined]
    ort.InferenceSession.__init__ = patched_init  # type: ignore[method-assign]


_install_ort_thread_cap()

import insightface
from insightface.app import FaceAnalysis
import cv2

app = FastAPI()

# Explicit model root to avoid relying on $HOME expansion at runtime.
# Defaults to the apps user's home; can be overridden via env var.
INSIGHTFACE_ROOT = os.environ.get("INSIGHTFACE_ROOT", "/home/apps/.insightface")

app_state = FaceAnalysis(
    name="buffalo_l",
    providers=["CPUExecutionProvider"],
    root=INSIGHTFACE_ROOT,
)
app_state.prepare(ctx_id=0, det_size=(640, 640))


def read_image(file: UploadFile):
    raw = file.file.read()
    if not raw:
        raise HTTPException(status_code=422, detail="empty image upload")

    data = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=422, detail="invalid or unsupported image data")

    return img


@app.get("/health")
async def health():
    # Simple check for the model initialization
    if app_state is None:
        return {"status": "error", "message": "FaceAnalysis model not initialized"}
    return {"status": "ok"}


@app.post("/embedding")
async def get_embedding(file: UploadFile = File(...)):
    img = read_image(file)
    faces = app_state.get(img)

    if len(faces) == 0:
        return {"error": "no face detected"}

    embedding = faces[0].embedding.tolist()
    return {"embedding": embedding}


@app.post("/verify")
async def verify(file1: UploadFile = File(...), file2: UploadFile = File(...)):
    img1 = read_image(file1)
    img2 = read_image(file2)

    f1 = app_state.get(img1)
    f2 = app_state.get(img2)

    if len(f1) == 0 or len(f2) == 0:
        return {"error": "face missing"}

    emb1 = f1[0].embedding
    emb2 = f2[0].embedding

    sim = float(np.dot(emb1, emb2) / (np.linalg.norm(emb1) * np.linalg.norm(emb2)))

    return {"similarity": sim}


@app.post("/detect")
async def detect(file: UploadFile = File(...)):
    img = read_image(file)
    height, width, _ = img.shape
    faces = app_state.get(img)

    result = []
    for f in faces:
        result.append({
            "bbox": f.bbox.tolist(),
            "kps": f.kps.tolist(),
            "embedding": f.embedding.tolist()
        })

    return {
        "faces": result,
        "width": width,
        "height": height
    }
