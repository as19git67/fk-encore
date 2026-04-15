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

### Automatisches tägliches Backup (empfohlen)

Das Repo enthält einen Host-Hook, der täglich einen **anwendungs-konsistenten
ZFS-Snapshot** inklusive `pg_dump` der Haupt-DB erzeugt. Der Ablauf:

1. Host-Cron ruft `POST /internal/backup/start` — fk-encore pausiert die
   Scan-Worker, setzt das Cluster per `pg_backup_start()` in den Backup-Modus
   und schreibt einen `pg_dump` nach `/mnt/backup/encore-<label>.dump`.
2. Der Host macht `zfs snapshot -r tank/vivanty@<label>` — pgdata + Fotos +
   der gerade erstellte Dump sind damit konsistent im Snapshot.
3. Host-Cron ruft `POST /internal/backup/stop` — `pg_backup_stop()`, Worker
   laufen wieder.

Eine Sicherheits-Zeitschaltuhr (default 30 Minuten) beendet den Backup-Modus
automatisch, falls `/stop` nie ankommt — damit kann das WAL nicht endlos
wachsen.

**Installation auf dem Host (einmalig, als root):**

```bash
sudo ./scripts/host/install-backup-hook.sh
# oder nicht-interaktiv:
sudo ./scripts/host/install-backup-hook.sh --dataset tank/vivanty
```

Wichtig: Alle persistenten Artefakte landen unter
`/mnt/<dataset>/fk-encore-hook/` — also auf dem ZFS-Dataset selbst und
**nicht** unter `/etc` oder `/usr/local/sbin`. Grund: TrueNAS SCALE tauscht
bei jedem Upgrade das Root-Dateisystem komplett aus (neues Boot-
Environment), Dateien unter `/etc/…` würden dabei verloren gehen. Datasets
bleiben erhalten.

Der Installer:

1. Fragt interaktiv nach dem Dataset (falls nicht per `--dataset` gesetzt)
2. Legt `/mnt/<dataset>/fk-encore-hook/` mit Token (0600) und Script (0755) an
3. Druckt am Ende den generierten Token **und** die genauen Felder, die
   für den täglichen Cron-Job in der TrueNAS-UI auszufüllen sind

Den Token in die `.env` neben der `docker-compose.yml` eintragen und den
Container neu starten:

```env
BACKUP_TOKEN=<vom Installer generierter Wert>
```

```bash
docker compose up -d --no-deps app
```

**Cron-Job über die TrueNAS-UI einrichten** (nicht über `/etc/cron.d/`, das
überlebt den nächsten TrueNAS-Upgrade nicht):

System Settings → Advanced → Cron Jobs → Add

| Feld          | Wert |
|---------------|------|
| Description   | `fk-encore daily backup` |
| Command       | `ZFS_DATASET=<dataset> /mnt/<dataset>/fk-encore-hook/fk-encore-backup.sh` |
| Run As User   | `root` |
| Schedule      | Custom → `0 3 * * *` (03:00 UTC) |
| Enabled       | yes |

Der Installer druckt die genaue Command-Zeile zum Kopieren aus.

Die `/internal/backup/*` Endpunkte sind zusätzlich per CIDR-Allow-List
abgesichert (Standard: Loopback + RFC1918 + IPv6 ULA). Damit werden
Requests aus dem öffentlichen Internet selbst dann abgelehnt, wenn der
Token einmal leakt — die Standard-Liste deckt Host-→Container-Traffic
über die Docker-Bridge (SNAT auf `172.17.0.1` o. ä.) bereits ab, es ist
normalerweise keine Anpassung nötig. Falls doch: via `BACKUP_ALLOW_CIDRS`
in der `.env` überschreiben.

Details und Konfiguration siehe `scripts/host/README.md`.

### Wiederherstellen

Zwei Pfade werden unterstützt:

**A) Vollständiger Rollback (Fotos + DB, schnell):**

```bash
docker compose down
sudo zfs rollback -r tank/vivanty@daily-20260413-030000
docker compose up -d
```

**B) Nur DB aus `pg_dump` wiederherstellen (Opt-in beim Start):**

```bash
# 1. Dump-Datei als "restore-*" im Backup-Verzeichnis ablegen
cp /mnt/backup/encore-daily-20260413-030000.dump \
   /mnt/backup/restore-20260414-rollback.dump

# 2. Container neustarten
docker compose restart app
```

Beim Start erkennt fk-encore die Datei, legt zunächst zur Sicherheit einen
`pre-restore-<ISO>.dump` des aktuellen DB-Stands an, führt `pg_restore
--clean --if-exists` aus und benennt die Trigger-Datei in
`restored-…` um, damit der Restore beim nächsten Start nicht erneut läuft.

**Notfall-Backup ohne ZFS-Snapshot (z. B. auf Nicht-TrueNAS-Systemen):**

```bash
# Nur die Haupt-DB — Fotos separat per rsync/etc. sichern
docker exec fk-encore-app sh -c 'pg_dump -Fc --no-owner "$POSTGRES_DATABASE" > /mnt/backup/encore-manual.dump'
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
