FROM python:3.12-slim-bookworm

# Create a non-root "apps" user matching TrueNAS SCALE's built-in apps user
# (UID/GID 568) so bind-mounted ZFS datasets can be owned accordingly.
# getent asserts the user really made it into /etc/passwd — otherwise the
# build fails loudly instead of producing an image that crashes at runtime.
RUN groupadd --gid 568 apps \
    && useradd --uid 568 --gid 568 --create-home --shell /bin/bash apps \
    && getent passwd 568 \
    && getent group 568

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Cache-related env vars as absolute paths. Set each on its own ENV line so
# they definitely propagate to both build-time RUN steps and the runtime CMD.
ENV HOME=/home/apps
ENV USER=apps
ENV LOGNAME=apps
ENV XDG_CACHE_HOME=/home/apps/.cache
ENV HF_HOME=/home/apps/.cache/huggingface
ENV HUGGINGFACE_HUB_CACHE=/home/apps/.cache/huggingface/hub
ENV TORCH_HOME=/home/apps/.cache/torch

# Pre-download model weights into the explicit cache dir so the non-root
# apps user can load them at runtime. cache_dir= is passed explicitly so the
# download never depends on $HOME expansion. The shell retry loop rides out
# transient huggingface.co 503s during build — transformers' built-in retry
# only waits up to 8s, which is too short for longer outages.
RUN mkdir -p /home/apps/.cache/huggingface /home/apps/.cache/torch \
    && for attempt in 1 2 3 4 5; do \
         python -c "from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection; AutoProcessor.from_pretrained('IDEA-Research/grounding-dino-base', cache_dir='/home/apps/.cache/huggingface'); AutoModelForZeroShotObjectDetection.from_pretrained('IDEA-Research/grounding-dino-base', cache_dir='/home/apps/.cache/huggingface'); print('Model pre-downloaded.')" && break; \
         if [ "$attempt" = "5" ]; then echo "Model download failed after 5 attempts"; exit 1; fi; \
         sleep_time=$((attempt * 30)); \
         echo "Attempt $attempt failed, retrying in ${sleep_time}s..."; \
         sleep "$sleep_time"; \
       done \
    && chown -R 568:568 /home/apps /app

EXPOSE 8000

USER 568:568

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
