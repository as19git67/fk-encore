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

# Pre-download InsightFace models into a fixed location that matches what
# main.py uses at runtime (INSIGHTFACE_ROOT). Passing `root=` explicitly
# avoids any dependence on $HOME expansion.
RUN mkdir -p /home/apps/.insightface \
    && python -c "from insightface.app import FaceAnalysis; FaceAnalysis(name='buffalo_l', root='/home/apps/.insightface').prepare(ctx_id=-1)" \
    && chown -R 568:568 /home/apps/.insightface

COPY main.py /app/main.py
WORKDIR /app
RUN chown -R 568:568 /app

# Suppress onnxruntime warnings (Optional, but can help)
ENV ORT_LOGGING_LEVEL=3
ENV HOME=/home/apps
ENV INSIGHTFACE_ROOT=/home/apps/.insightface

EXPOSE 8000

USER 568:568

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
