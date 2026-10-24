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

## `diagnose-autopick-delta.mjs`

Etappe 0 aus `documentation/auto-pick-face-relevance.md`. Zerlegt den Score-Abstand Δ
zwischen Top-Pick und bestem Nicht-Pick in die Beiträge der einzelnen
Signale.

**Warum:** Δ entscheidet über `ai_picked_confidence = 'high'` und damit
darüber, was der Bulk-Accept ungefragt anwendet. Die erste Messung zeigte,
dass `face_sharpness` den Δ rechnerisch gar nicht erzeugen kann (σ ≈ 0.035
bei Gewicht 0.40 → ~0.014 Beitrag, Schwelle 0.10), das `high`-Bucket aber
mit 75,9 % deutlich schlechter trifft als der Rest (97,3 %). Also: welcher
Term macht den Abstand — und unterscheidet er sich zwischen Treffern und
Fehlgriffen?

**Aufbau des Reports:**

1. **Validierung** — der gespeicherte Score wird aus den gespeicherten
   Signalen nachgerechnet. Stimmt das nicht, wurden die Picks mit anderen
   Gewichten erzeugt und der Rest ist nicht belastbar.
2. Beitrag je Signal zum Δ, nach Konfidenz-Bucket.
3. **Der eigentliche Befund:** unterscheidet sich die Zerlegung zwischen
   `high`-Treffern und `high`-Fehlgriffen? Das Signal mit der größten
   positiven Differenz ist der Verursacher.
4. Wie oft trägt ein einzelnes Signal die Gruppe allein über die 0.10-Schwelle.

Die Gewichte werden nicht dupliziert, sondern aus
`photo/group-auto-pick.ts` gelesen; kalibrierte Per-Nutzer-Gewichte aus
`ai_pick_user_weights` haben Vorrang.

```bash
POSTGRES_DATABASE=encore node scripts/photos/diagnose-autopick-delta.mjs
USER_ID=1 POSTGRES_DATABASE=encore node scripts/photos/diagnose-autopick-delta.mjs
```

Gruppen mit gemischten Zweigen (ein Foto mit, eines ohne Gesicht) werden
übersprungen und ausgewiesen — dort sind die Signalmengen verschieden, eine
termweise Differenz wäre bedeutungslos.

## `diagnose-autopick-calibration.mjs`

Etappe 0b. Prüft, ob die **Größe** des Δ überhaupt Trefferwahrscheinlichkeit
vorhersagt.

**Warum:** Etappe 0 fand keinen einzelnen Term, der die Fehlgriffe im
`high`-Bucket erklärt (größte Differenz 0.0092 bei einem Median-Δ von
0.1661). Damit steht die Schwelle selbst zur Prüfung, nicht mehr ein
einzelnes Signal.

**Kernmaß ist der Lift über einer Zufallsbasislinie**, nicht die nackte
Trefferquote. Eine Gruppe aus 2 Fotos, von denen eines behalten wird, trifft
man zu 50 % durch Raten; eine aus 5 Fotos mit 4 behaltenen zu 80 %. Ohne
diese Korrektur vergleicht man unterschiedlich schwere Bins und liest
Struktur, wo keine ist. Die Basislinie ist hypergeometrisch:
`1 - C(hidden, picks) / C(members, picks)`.

Verwendet wird der **gespeicherte** `runner_up_delta` — die Größe, die
seinerzeit tatsächlich über die Einstufung entschied. Abschnitt 3 wiederholt
die Messung auf der Teilmenge, deren Score sich mit den heutigen Gewichten
exakt reproduzieren lässt (Robustheitsprüfung, weil in Etappe 0 nur 58,2 %
reproduzierbar waren).

```bash
POSTGRES_DATABASE=encore node scripts/photos/diagnose-autopick-calibration.mjs
```

**Entscheidungslogik:** steigt der Lift mit dem Δ, taugt der Mechanismus und
nur die Schwellenhöhe ist zu diskutieren. Bleibt er flach, trägt der Δ keine
Information — dann würde eine höhere Schwelle nur weniger Gruppen
auto-akzeptieren, ohne dass die verbleibenden zuverlässiger wären.

## `diagnose-face-sharpness-variance.mjs`

Etappe 2. Prüft die Vorhersage **V1** aus
`documentation/auto-pick-face-relevance.md`: Hat eine prominenzgewichtete
Aggregation von `faces.sharpness` innerhalb einer Ähnlichkeitsgruppe mehr
Streuung als das heutige Minimum?

**Warum das die wichtigste Einzelmessung des Umbaus ist:**
`face_sharpness` ist das Minimum über alle Detektionen eines Fotos. Ist das
unschärfste Gesicht in jedem Frame eines Bursts dasselbe winzige
Hintergrundgesicht — bei kleinen Gesichtern der Regelfall — dann ist das
Minimum über alle Frames identisch, und die Schärfeschwankung des
Hauptmotivs wird gelöscht, bevor sie das Scoring erreicht. Trifft V1 nicht
zu, ist diese Kernannahme falsch und an der Scoring-Formel darf nichts
geändert werden.

**Voraussetzung:** `faces.sharpness` ist befüllt — über den Button
„Gesichtsschärfe nachtragen" in der Datenverwaltung bzw.
`POST /photos/backfill-face-sharpness`. Abschnitt 1 des Reports weist die
Abdeckung aus; Gruppen mit unvollständigem Backfill werden übersprungen und
ausgewiesen, damit „heute" und „neu" nie auf verschiedenen Datenbeständen
verglichen werden.

**Aufbau des Reports:**

1. Abdeckung des Backfills — getrennt nach „noch nachzutragen" und „unter
   der Messgrenze" (letztere bleiben dauerhaft `NULL`).
1b. **Verteilung der Messwerte.** Anteil an der 1.0-Decke plus Perzentile
   von Score und Rohvarianz. `LAPLACIAN_FULL_SCALE` ist am Frontend
   kalibriert, das die *gerenderte* (herunterskalierte) Datei misst;
   serverseitig wird das Original gelesen und kann sättigen. Sitzen die
   Werte an der Decke, misst ein σ von 0 die Normalisierung und nicht die
   Bilder — der Vollausschlag wird dann anhand der gespeicherten Rohvarianz
   (`faces.sharpness_variance`) neu gesetzt, was ein `UPDATE` ist und kein
   zweiter Messlauf.
2. Auswertbare Gruppen (inkl. Ausschlussgründen).
3. **Die V1-Messung:** σ innerhalb der Gruppe, Minimum gegen
   prominenzgewichtet, dazu der Anteil der Gruppen mit σ ≈ 0 — die
   Enthaltungsquote in Rohform.
4. Bewegungsmaß: wie oft das Minimum heute gar keinen Sieger benennt, wie
   oft die gewichtete Variante den Gleichstand auflöst, und wie oft ein
   heute eindeutiger Sieger wechselt.
5. Urteil zu V1.

Die Prominenz-Konstanten werden nicht dupliziert, sondern aus
`photo/group-auto-pick.ts` gelesen.

```bash
POSTGRES_DATABASE=encore node scripts/photos/diagnose-face-sharpness-variance.mjs
USER_ID=1 POSTGRES_DATABASE=encore node scripts/photos/diagnose-face-sharpness-variance.mjs
```

**Entscheidungslogik:** steigt die Streuung und fällt der σ ≈ 0-Anteil, war
die Varianz vorhanden und wurde vom Minimum maskiert — dann ist der Weg zur
Formeländerung frei (Schwellwerte weiterhin über den Replay, nicht geraten).
Bleibt beides gleich, gehört das Ergebnis als dritte widerlegte Hypothese
ins Konzept.

**Das Skript verweigert das Urteil**, solange der Backfill unvollständig,
die Skala gesättigt oder die auswertbare Menge kleiner als 30 Gruppen ist.
Der erste Produktivlauf (3,3 % Abdeckung, alle Werte an der Decke) hätte
sonst „V1 widerlegt" gemeldet, obwohl gar nichts gemessen war — siehe
Etappe 2 in `documentation/auto-pick-face-relevance.md`.

## `diagnose-eyes-open.mjs`

Dieselbe Auswertung gibt es für den eigenen Nutzer ohne Skript: Karte
„Augen und Lächeln“ unter Fotos › Einstellungen › Ästhetik
(`POST /photos/aesthetic/face-signals`, `photo/face-signals-report.ts`).
Das Skript bleibt für den Blick über alle Nutzer und den Report als Datei.

Etappe 5. Trifft die Augenöffnung aus den Gesichtslandmarken die
Entscheidungen des Nutzers besser als der heutige CLIP-Wert `eyes_open`?

Der Gesichtsdienst liefert seit Migration `0272` je Gesicht die Punkte der
beiden Landmarken-Modelle aus `buffalo_l` (106 und 68 Punkte). Daraus
berechnet `photo/face-eyes.ts` zwei Rohwerte: `faces.eye_aspect`
(Höhe zu Breite der Augenkontur, 106 Punkte) und `faces.eye_aspect_68`
(klassisches Eye Aspect Ratio). Beide bleiben gespeichert, weil vorher nicht
feststeht, welches Modell einem sich schließenden Lid folgt.

**Voraussetzung:** Backfill „Gesichtslandmarken nachtragen" (Fotos ›
Einstellungen › Wartung, `POST /photos/backfill-face-landmarks`). Der Knopf
legt je betroffenem Foto einen Job `face_landmarks` in die Scan-Queue
(Fortschritt unter Fotos › Einstellungen › Scan-Queue). Der Job lässt
die Gesichtserkennung erneut laufen und ordnet die Treffer über die
Box-Überlappung den gespeicherten Gesichtern zu; Personenzuordnungen bleiben
unberührt.

**Aufbau des Reports:** Abdeckung, Verteilung beider Werte (geschlossene
Augen sollten als linker Ausläufer sichtbar sein), dann paarweise in
geprüften Gruppen „behalten gegen ausgeblendet": wie oft das Signal ein Paar
entscheidet und wie oft das behaltene Foto den höheren Wert hat — jeweils
gegen CLIP auf denselben Paaren. Je Foto zählt der prominenzgewichtete
Mittelwert über die Gesichter, nicht das Minimum.

```bash
POSTGRES_DATABASE=encore node scripts/photos/diagnose-eyes-open.mjs
```

Seit Migration `0273` wertet derselbe Report auch den Mund aus
(Abschnitt 3b): `faces.mouth_lift` (Hebung der Mundwinkel über die
Lippenmitte) und `faces.mouth_width` (Mundbreite zum Augenabstand), je
Modell. Es gibt kein heutiges Lächeln-Signal; Maßstab ist der Zufall (50 %).
Gesichter, die schon Landmarken haben, bekommen die Mundwerte beim selben
Backfill aus den gespeicherten Punkten nachgerechnet, ohne neue Erkennung.

**Das Skript verweigert das Urteil** unter 90 % Abdeckung oder 30
entschiedenen Paaren. Ein „besser als CLIP" ändert noch nichts an
`scorePhoto()`; das geschieht erst nach dem Replay mit neu gelernten
Gewichten.
