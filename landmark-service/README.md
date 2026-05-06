# Landmark Detection Service

Dieser Service bietet Erkennung von Sehenswürdigkeiten (Landmarks) und architektonischen Kategorien mittels [Grounding DINO](https://huggingface.co/IDEA-Research/grounding-dino-base).

## Architektur

- **Framework**: FastAPI
- **Modell**: `IDEA-Research/grounding-dino-base` (Zero-Shot Object Detection)
- **Backend**: PyTorch (CPU/CUDA)

## Endpunkte

### `GET /health`
Überprüft den Status des Services.

### `POST /detect`
Erkennt Sehenswürdigkeiten in einem Bild basierend auf einer Liste von Klassen.

**Anfrage (Multipart Form):**
- `file`: Bilddatei
- `classes` (optional): Punkt-separierte Liste von Klassen (z.B. `Kirche . Schloss . Turm`). Standardmäßig wird eine umfangreiche Liste deutscher Begriffe verwendet.
- `threshold` (optional): Konfidenz-Schwellenwert (Standard: `0.35`).

**Antwort:**
```json
{
  "landmarks": [
    {
      "label": "Kirche",
      "score": 0.89,
      "box": [x1, y1, x2, y2]
    }
  ]
}
```

## Konfiguration

Die Konfiguration erfolgt über Umgebungsvariablen:

| Variable | Beschreibung | Standardwert |
|----------|--------------|--------------|
| `MODEL_ID` | HuggingFace Modell-ID | `IDEA-Research/grounding-dino-base` |
| `LANDMARK_THRESHOLD` | Standard-Schwellenwert für Erkennungen | `0.35` |
| `LOG_LEVEL` | Logging-Level | `INFO` |
| `HF_HOME` | Cache-Pfad für HuggingFace Modelle | `/home/apps/.cache/huggingface` |

## Lokale Entwicklung

Starten des Services mit Docker Compose:

```bash
docker-compose up --build
```

Der Service ist dann unter `http://localhost:8003` erreichbar.

### Hinweis zum ersten Start
Beim ersten Start wird das Modell (~1.5 GB) von HuggingFace heruntergeladen. Dies kann je nach Internetverbindung einige Minuten dauern.

## Tests

Die Tests können lokal mit `pytest` ausgeführt werden:

```bash
pip install -r requirements.txt pytest httpx
pytest
```
