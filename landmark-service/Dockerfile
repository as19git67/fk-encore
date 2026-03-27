FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Pre-download model weights at build time to avoid cold-start delays
RUN python -c "\
from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection; \
AutoProcessor.from_pretrained('IDEA-Research/grounding-dino-base'); \
AutoModelForZeroShotObjectDetection.from_pretrained('IDEA-Research/grounding-dino-base'); \
print('Model pre-downloaded.')"

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
