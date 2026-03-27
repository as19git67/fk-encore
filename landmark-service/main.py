"""Landmark detection service using Grounding DINO (via HuggingFace Transformers)."""

from __future__ import annotations

import io
import logging
import os
import torch
from fastapi import FastAPI, File, Form, UploadFile
from PIL import Image
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

app = FastAPI(title="Landmark Detection Service")

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
MODEL_ID = os.environ.get("MODEL_ID", "IDEA-Research/grounding-dino-base")
DEFAULT_THRESHOLD = float(os.environ.get("LANDMARK_THRESHOLD", "0.35"))

# Default prompt covers common landmark and architectural categories.
# Entries are separated by " . " as required by Grounding DINO.
DEFAULT_CLASSES = (
    "church . cathedral . castle . mosque . temple . synagogue . "
    "tower . bridge . monument . statue . lighthouse . palace . "
    "ruins . museum . stadium . historic building . famous landmark . "
    "windmill . city hall . opera house . parliament building"
)

logger.info("Loading Grounding DINO model '%s' on %s ...", MODEL_ID, DEVICE)
processor = AutoProcessor.from_pretrained(MODEL_ID)
model = AutoModelForZeroShotObjectDetection.from_pretrained(MODEL_ID).to(DEVICE)
model.eval()
logger.info("Grounding DINO model loaded.")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "device": str(DEVICE), "model": MODEL_ID}


@app.post("/detect-landmarks")
async def detect_landmarks(
    file: UploadFile = File(...),
    classes: str = Form(DEFAULT_CLASSES),
    threshold: float = Form(DEFAULT_THRESHOLD),
) -> dict:
    """Detect landmarks in an uploaded image and return bounding boxes.

    Response format:
    {
        "landmarks": [
            {
                "label": "church",
                "confidence": 0.87,
                "bbox": {"x": 0.1, "y": 0.05, "width": 0.3, "height": 0.6}
            }
        ],
        "width": 1920,
        "height": 1080
    }

    All bbox values are normalized to [0, 1] relative to image dimensions,
    matching the same format used by the InsightFace face detection service.
    """
    content = await file.read()
    image = Image.open(io.BytesIO(content)).convert("RGB")
    width, height = image.size

    inputs = processor(images=image, text=classes, return_tensors="pt").to(DEVICE)

    with torch.no_grad():
        outputs = model(**inputs)

    target_sizes = torch.tensor([[height, width]])
    results = processor.post_process_grounded_object_detection(
        outputs,
        inputs.input_ids,
        box_threshold=threshold,
        text_threshold=0.25,
        target_sizes=target_sizes,
    )[0]

    landmarks = []
    for score, label, box in zip(
        results["scores"].tolist(),
        results["labels"],
        results["boxes"].tolist(),
    ):
        x_min, y_min, x_max, y_max = box
        landmarks.append(
            {
                "label": label,
                "confidence": round(score, 4),
                "bbox": {
                    "x": round(x_min / width, 4),
                    "y": round(y_min / height, 4),
                    "width": round((x_max - x_min) / width, 4),
                    "height": round((y_max - y_min) / height, 4),
                },
            }
        )

    return {"landmarks": landmarks, "width": width, "height": height}
