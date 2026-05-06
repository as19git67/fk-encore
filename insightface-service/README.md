# InsightFace Service

Dieser Service bietet Gesichtserkennung und -analyse basierend auf der [InsightFace](https://github.com/deepinsight/insightface) Bibliothek.

## Architektur

- **Framework**: FastAPI
- **Modell**: `buffalo_l` (vordefiniertes InsightFace-Modellpaket)
- **Backend**: ONNX Runtime (CPU)

## Endpunkte

### `GET /health`
Überprüft den Status des Services und ob das Modell erfolgreich geladen wurde.

### `POST /detect`
Erkennt Gesichter in einem Bild und gibt Bounding-Boxen, Keypoints und Embeddings zurück.

**Anfrage:**
- `file`: Multipart-Form-Data Bilddatei

**Antwort:**
```json
{
  "faces": [
    {
      "bbox": [x1, y1, x2, y2],
      "kps": [[x, y], ...],
      "embedding": [0.1, -0.2, ...]
    }
  ],
  "width": 1920,
  "height": 1080
}
```

### `POST /embedding`
Extrahiert das Embedding des ersten erkannten Gesichts in einem Bild.

**Anfrage:**
- `file`: Multipart-Form-Data Bilddatei

**Antwort:**
```json
{
  "embedding": [0.1, -0.2, ...]
}
```

### `POST /verify`
Berechnet die Kosinus-Ähnlichkeit zwischen den Gesichtern in zwei Bildern.

**Anfrage:**
- `file1`: Bilddatei 1
- `file2`: Bilddatei 2

**Antwort:**
```json
{
  "similarity": 0.95
}
```

## Konfiguration

Die Konfiguration erfolgt über Umgebungsvariablen:

| Variable | Beschreibung | Standardwert |
|----------|--------------|--------------|
| `INSIGHTFACE_ROOT` | Pfad zum Modell-Verzeichnis | `/home/apps/.insightface` |
| `ORT_LOGGING_LEVEL` | Logging-Level für ONNX Runtime | `3` (Error) |

## Lokale Entwicklung

Starten des Services mit Docker Compose:

```bash
docker-compose up --build
```

Der Service ist dann unter `http://localhost:8002` erreichbar.

## Tests

Die Tests können lokal mit `pytest` ausgeführt werden:

```bash
pip install -r requirements.txt pytest httpx
pytest
```
