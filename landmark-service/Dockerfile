FROM python:3.12-slim-bookworm

# Create a non-root "apps" user matching TrueNAS SCALE's built-in apps user
# (UID/GID 568) so bind-mounted ZFS datasets can be owned accordingly.
RUN groupadd -g 568 apps \
    && useradd -u 568 -g 568 -m -s /bin/bash apps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Pre-download model weights at build time to avoid cold-start delays.
# transformers caches under ~/.cache/huggingface (via $HOME), so we point
# HOME at the apps user's home during the download and chown the result.
RUN HOME=/home/apps python -c "\
from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection; \
AutoProcessor.from_pretrained('IDEA-Research/grounding-dino-base'); \
AutoModelForZeroShotObjectDetection.from_pretrained('IDEA-Research/grounding-dino-base'); \
print('Model pre-downloaded.')" \
    && chown -R 568:568 /home/apps /app

ENV HOME=/home/apps

EXPOSE 8000

USER 568:568

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
