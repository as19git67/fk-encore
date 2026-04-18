# llm-service

Lokaler FastAPI-Service, der zwei Modelle in einem Prozess hält:

- **Llama-3.2-3B-Instruct (GGUF, Q4_K_M)** via `llama-cpp-python` für
  Dokument-Klassifikation und Zusammenfassung.
- **intfloat/multilingual-e5-base** via `sentence-transformers` für 768-dim
  Text-Embeddings (deutsch-/englisch-stark).

Endpunkte: `POST /classify`, `POST /embed`, `GET /healthz`.

## Modell-Lebenszyklus

Die Modelle werden **bewusst nicht** ins Image gebacken — das würde das Image
um ~2 GB aufblähen und jeden Rebuild verlangsamen. Stattdessen lebt alles
unter `/models`, gemountet aus einem Host-Volume.

1. **Einmaliger Download** — vor dem ersten Start:

   ```bash
   docker compose run --rm llm-service /usr/local/bin/download_model.sh
   ```

   Lädt die GGUF-Datei nach `/models/llama.gguf` und das Embedding-Repo nach
   `/models/st-cache/…`. Beides idempotent (curl `--continue`, HF snapshot).

2. **Container-Start** — `main.py` macht **keinen Netzwerk-Zugriff**: es
   `mmap`t die GGUF von Disk (~2 GB, 2–10 s auf SSD) und lädt den Embedder
   aus `SENTENCE_TRANSFORMERS_HOME`.

## Konfiguration (ENV)

| Variable | Default | Bedeutung |
|---|---|---|
| `MODELS_DIR` | `/models` | Wurzel für alle Modell-Artefakte |
| `LLM_MODEL_PATH` | `/models/llama.gguf` | Pfad zur GGUF-Datei |
| `LLM_MODEL_URL` | *(siehe `download_model.sh`)* | HF-Download-URL |
| `LLM_CTX` | `8192` | Kontext-Fenster |
| `LLM_THREADS` | `$(nproc)` | CPU-Threads für llama.cpp |
| `LLM_GPU_LAYERS` | `0` | Auf GPU zu offloadende Layer (nur mit CUDA-Build) |
| `EMBEDDING_MODEL` | `intfloat/multilingual-e5-base` | Sentence-Transformers Repo |
| `LOG_LEVEL` | `INFO` | uvicorn / Root-Logger |

## Performance-Builds (optional)

Der Default installiert das CPU-only Wheel von `llama-cpp-python`. Für mehr
Speed auf x86:

```dockerfile
RUN CMAKE_ARGS="-DLLAMA_BLAS=ON -DLLAMA_BLAS_VENDOR=OpenBLAS" \
    pip install --no-binary llama-cpp-python llama-cpp-python==0.3.2
```

Für CUDA-GPU: entsprechenden `-DLLAMA_CUBLAS=ON` Build plus `LLM_GPU_LAYERS>0`.
