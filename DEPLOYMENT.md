# FK Encore – Deployment mit Docker Compose

## Voraussetzungen

- Docker (mit Compose v2)
- Mindestens **8 GB RAM** (die ML-Modelle für Gesichtserkennung und Embeddings brauchen Speicher)

## Schnellstart

```bash
# 1. Konfiguration erstellen
cp docker-compose.env.example .env

# 2. .env anpassen (mindestens ADMIN_PASSWORD ändern!)
nano .env

# 3. Starten
docker compose up -d

# 4. Logs prüfen
docker compose logs -f
```

Die App ist dann unter **http://localhost:8080** erreichbar.

## Services

| Service | Beschreibung | Interner Port | Standard-Host-Port |
|---------|-------------|---------------|---------------------|
| `app` | Encore.ts Hauptanwendung (Frontend + API) | 8080 | 8080 |
| `insightface` | Gesichtserkennung (InsightFace/buffalo_l) | 8000 | – (nur intern) |
| `embedding_service` | Foto-Embeddings (CLIP + DINOv2) | 8000 | – (nur intern) |
| `embedding_postgres` | PostgreSQL mit pgvector für Embeddings | 5432 | – (nur intern) |

Die ML-Services (insightface, embedding_service) sind nur intern erreichbar und nicht von außen zugänglich.

## Konfiguration

### Pflicht-Variablen

| Variable | Beschreibung |
|----------|-------------|
| `ADMIN_PASSWORD` | Passwort für den initialen Admin-Account |

### Optionale Variablen

| Variable | Default | Beschreibung |
|----------|---------|-------------|
| `APP_PORT` | `8080` | Host-Port für die App |
| `ADMIN_EMAIL` | `admin@example.com` | E-Mail des Admin-Accounts |
| `ADMIN_NAME` | `Admin` | Name des Admin-Accounts |
| `RP_ID` | `localhost` | WebAuthn Domain (ohne Protokoll/Port) |
| `RP_ORIGIN` | `http://localhost:8080` | WebAuthn Origin (volle URL) |
| `DB_TYPE` | `sqlite` | Datenbank-Typ (`sqlite` oder `postgres`) |
| `ENABLE_LOCAL_FACES` | `true` | Gesichtserkennung aktivieren |
| `FACE_DISTANCE_THRESHOLD` | `0.42` | Schwellwert für Gesichts-Matching (niedriger = strenger) |
| `CLIP_MODEL_NAME` | `ViT-B-32` | OpenCLIP Modell |
| `CLIP_PRETRAINED` | `openai` | Pretrained Weights |
| `DINO_MODEL_NAME` | `facebook/dinov2-base` | DINOv2 Modell |
| `EMBEDDING_DB_PASSWORD` | `postgres` | Passwort für die Embedding-Datenbank |

### Beispiel: Produktions-Setup hinter Reverse Proxy

```env
APP_PORT=8080
ADMIN_EMAIL=admin@meinedomain.de
ADMIN_NAME=Administrator
ADMIN_PASSWORD=ein-sicheres-passwort-hier
RP_ID=fotos.meinedomain.de
RP_NAME=Familienfotos
RP_ORIGIN=https://fotos.meinedomain.de
EMBEDDING_DB_PASSWORD=ein-anderes-passwort
```

## Daten & Volumes

| Volume | Inhalt |
|--------|--------|
| `app-data` | SQLite-Datenbank + hochgeladene Fotos |
| `embedding-pgdata` | PostgreSQL-Daten für Foto-Embeddings |

### Backup

```bash
# App-Daten (SQLite DB + Fotos)
docker compose cp app:/mnt/data ./backup-data

# Embedding-Datenbank
docker compose exec embedding_postgres pg_dump -U postgres embeddings > backup-embeddings.sql
```

### Wiederherstellen

```bash
# App-Daten
docker compose cp ./backup-data/. app:/mnt/data

# Embedding-Datenbank
cat backup-embeddings.sql | docker compose exec -T embedding_postgres psql -U postgres embeddings
```

## Häufige Aufgaben

### Alle Services neu bauen

```bash
docker compose build --no-cache
docker compose up -d
```

### Logs eines einzelnen Services

```bash
docker compose logs -f app
docker compose logs -f embedding_service
docker compose logs -f insightface
```

### Service neustarten

```bash
docker compose restart app
```

### Alles stoppen und aufräumen

```bash
docker compose down          # Services stoppen
docker compose down -v       # Services stoppen + Volumes löschen (ACHTUNG: Datenverlust!)
```

## Fehlerbehebung

### "Embedding service unavailable"
Der Embedding-Service braucht beim ersten Start Zeit um die ML-Modelle zu laden (~1-2 Minuten). Prüfe den Status:
```bash
docker compose logs embedding_service
curl http://localhost:8001/health  # wenn Port exponiert
```

### "FACE_MODELS_NOT_LOADED"
InsightFace lädt beim ersten Start das buffalo_l-Modell. Das kann 1-2 Minuten dauern:
```bash
docker compose logs insightface
```

### Out of Memory
Die ML-Services brauchen zusammen ca. 4-6 GB RAM. Erhöhe das Docker-Speicherlimit falls nötig (Docker Desktop → Settings → Resources).
