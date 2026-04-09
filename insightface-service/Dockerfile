FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root "apps" user matching TrueNAS SCALE's built-in apps user
# (UID/GID 568) so bind-mounted ZFS datasets can be owned accordingly.
RUN groupadd -g 568 apps \
    && useradd -u 568 -g 568 -m -s /bin/bash apps

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Pre-download InsightFace models. The library resolves '~/.insightface' via
# $HOME, so point HOME at the apps user's home during the download and chown
# the result to the apps user so it is readable at runtime.
RUN HOME=/home/apps python -c "from insightface.app import FaceAnalysis; FaceAnalysis(name='buffalo_l').prepare(ctx_id=-1)" \
    && chown -R 568:568 /home/apps/.insightface

COPY main.py /app/main.py
WORKDIR /app
RUN chown -R 568:568 /app

# Suppress onnxruntime warnings (Optional, but can help)
ENV ORT_LOGGING_LEVEL=3 \
    HOME=/home/apps

EXPOSE 8000

USER 568:568

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
