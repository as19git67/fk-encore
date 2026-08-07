# Foto-Diagnose-Skripte

Read-only Auswertungen gegen die produktive Datenbank. Die Skripte führen
ausschließlich `SELECT`-Abfragen aus und schreiben ihren Report nach
`scripts/photos/out/` (gitignored).

## `diagnose-autopick-faces.mjs`

Prüft, ob die `min()`-Aggregation von `face_sharpness` / `eyes_open` im
embedding_service die Auto-Pick-Vorschläge auf Fotos mit vielen Gesichtern
verschlechtert.

**Hintergrund:** `face_sharpness` ist das Minimum über *alle* erkannten
Gesichter (Filter: nur ≥10 px Kantenlänge in der Quelle) und trägt zusammen
mit `eyes_open` 0.60 der Gewichte im Face-Zweig von `scorePhoto()`. Auf einem
Menschenmengen-Foto misst das Minimum damit potenziell den unschärfsten
Statisten im Hintergrund statt des Motivs — und kann zwischen zwei Frames
desselben Bursts springen, weil ein anderes Hintergrundgesicht das Minimum
stellt.

**Was ausgewertet wird** (alles aus bereits gespeicherten Daten, kein Re-Scan
nötig — der Pick liegt in `photo_groups.ai_pick_details`, die
Nutzer-Entscheidung in `photo_curation`):

1. Gespeicherte Kalibrierungs-Metadaten (Face- vs. Non-Face-Genauigkeit).
2. **Trefferquote nach Gesichtszahl** — die Kernmessung. Fällt sie zu den
   hohen Buckets hin ab, ist die Vermutung bestätigt.
3. Prominenz-Spreizung: wie oft ist das kleinste Gesicht viel kleiner als das
   größte (= wie oft misst `min()` etwas anderes als das Motiv).
4. Fotos, die nur durch winzige Detektionen in den Face-Zweig geraten.
5. Als "ignoriert" markierte Gesichter, die im Scoring trotzdem zählen.
6. Streuung von `face_sharpness` vs. `blur` innerhalb einer Gruppe
   (Signatur eines instabilen Minimums).

**Aufruf:**

```bash
# Auf dem Docker-Host (Port ist via DEPLOY_HOST_PORT_POSTGRES veroeffentlicht)
POSTGRES_DATABASE=encore node scripts/photos/diagnose-autopick-faces.mjs

# Von woanders, oder mit abweichenden Zugangsdaten
POSTGRES_CONNECTION_STRING=postgres://postgres:postgres@dbhost:5432/encore \
  node scripts/photos/diagnose-autopick-faces.mjs

# Nur ein Nutzer
USER_ID=3 POSTGRES_DATABASE=encore node scripts/photos/diagnose-autopick-faces.mjs
```

Verbindung wie beim Taxonomie-Diagnoseskript: `POSTGRES_CONNECTION_STRING`
oder `POSTGRES_HOST` / `PORT` / `USER` / `PASSWORD` / `DATABASE`.

Standard-DB ist `encore` — der Name aus `docker-compose.yml`
(`DEPLOY_PG_DATABASE`), nicht der `fk_encore`-Default aus `db/database.ts`,
der nur für die lokale Entwicklung gilt.

### Variante ohne Node: `diagnose-autopick-faces.sql`

Identische Auswertung als reines SQL, für den Fall dass der Postgres-Port
von der ausführenden Maschine aus **nicht** erreichbar ist (Firewall, DB nur
im Docker-Netz). Läuft direkt im DB-Container, braucht weder Node noch das
`pg`-Paket:

```bash
docker compose exec -T postgres \
  psql -U postgres -d encore -f - < scripts/photos/diagnose-autopick-faces.sql

# Nur ein Nutzer
docker compose exec -T postgres \
  psql -U postgres -d encore -v user_id=3 -f - < scripts/photos/diagnose-autopick-faces.sql
```

Ist der Port erreichbar, ist die `.mjs`-Variante der einfachere Weg — sie
formatiert den Report als Markdown-Datei statt als psql-Tabellen.

**Grenzen der Aussagekraft:** gemessen wird nur, wo bereits reviewt wurde und
ein Pick gespeichert ist. Reviewte Gruppen sind keine Zufallsstichprobe der
Bibliothek. Gruppen, in denen der Nutzer nichts ausgeblendet hat, werden
übersprungen — dort träfe jeder Pick trivial.
