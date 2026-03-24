from fastapi import FastAPI, UploadFile, File, HTTPException
import numpy as np
import insightface
from insightface.app import FaceAnalysis
import cv2

app = FastAPI()

app_state = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
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
