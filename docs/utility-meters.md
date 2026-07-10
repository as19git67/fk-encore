# Zählerstände (Utility Meters) — Feature-Plan

Neues Modul zur Erfassung und Auswertung von Haushaltszählern (Strom, Wasser,
Gas) sowie Betriebsstundenzählern (Pumpen, Kompressoren), inkl. Ablesung per
Foto/OCR, automatischer Erfassung per API und Verknüpfung mit
Finance-Transaktionen.

Status: Feature-Plan (GitHub Issue #792), noch nicht umgesetzt.

---

## 1. Ziele

- **Zähler verwalten**: Ein Zähler hat Namen, Typ, Standort, Einheit, Notizen
  und optional ein Foto. Anlegen/Bearbeiten nur mit Sonderrecht
  (Admin-Seite).
- **Gerätewechsel abbilden**: Ein Zähler (logische Messstelle) kann über die
  Zeit durch mehrere physische Geräte realisiert sein. Beim Tausch startet
  das neue Gerät bei 0 oder einem beliebigen Anfangswert. Der **absolute
  Gesamtstand** der Messstelle ist die Summe der Verbräuche aller Geräte und
  ist monoton steigend.
- **Ablesungen erfassen**: manuell im Formular, per Foto mit OCR-Erkennung
  des Zählerstands, oder automatisch über eine externe API (Gerät/Software
  pusht Werte). Datum + Uhrzeit werden immer mitgespeichert.
- **Auswertungen**: Verbrauch über Zeit, Vergleich mit historischen
  Zeiträumen, Anomalie-Erkennung (KI).
- **Finance-Verknüpfung**: Zahlungen (Abschläge, Jahresabrechnungen) können
  mit Ablesungen bzw. Zählern verknüpft werden.

Nicht-Ziele (vorerst): Tarifverwaltung/Kostenrechnung pro kWh, Import von
Versorger-Portalen, Smart-Meter-Protokolle (SML/MQTT) — die API-Ingestion ist
bewusst ein generischer HTTP-Endpunkt, Adapter dafür können extern laufen.

---

## 2. Domänenmodell

Zentrale Unterscheidung: **Messstelle** (`meter`) vs. **physisches Gerät**
(`meter_device`).

```
meter (Messstelle, logisch, dauerhaft)
 └── meter_device (physisches Gerät, zeitlich begrenzt)
      └── meter_reading (Ablesung eines Geräts zu einem Zeitpunkt)
```

Beispiel aus dem Issue (Wasser):

| Gerät | von | bis | Startwert | Endwert |
|---|---|---|---|---|
| Gerät 1 | 2020-02-10 | 2025-03-21 | 102 | 734 |
| Gerät 2 | 2025-03-21 | — | 3 | (laufend) |

Absoluter Gesamtstand heute = (734 − 102) + (aktueller Stand − 3).
Der Endwert eines Geräts ist die letzte Ablesung vor dem Ausbau (beim
„Ersetzen“ wird sie als Abschluss-Ablesung miterfasst).

### 2.1 Tabellen (Drizzle, `db/schema.ts`)

```
meters
  id            serial PK
  name          text NOT NULL
  type          text NOT NULL  -- 'electricity' | 'water' | 'gas' | 'operating_hours'
  unit          text NOT NULL  -- 'kWh' | 'm3' | 'h' | frei
  location      text
  notes         text
  photo_path    text           -- Foto der Messstelle (optional)
  decimals      integer NOT NULL DEFAULT 1  -- Nachkommastellen bei Eingabe/Anzeige
  group_id      integer REFERENCES groups(id)  -- Sichtbarkeit analog documents (§4)
  owner_user_id integer NOT NULL REFERENCES users(id)
  created_at / updated_at timestamptz

meter_devices
  id            serial PK
  meter_id      integer NOT NULL REFERENCES meters(id) ON DELETE CASCADE
  serial_number text
  installed_at  timestamptz NOT NULL
  removed_at    timestamptz            -- NULL = aktives Gerät
  start_value   numeric(14,3) NOT NULL -- Stand bei Einbau
  end_value     numeric(14,3)          -- Stand bei Ausbau (NULL solange aktiv)
  notes         text
  -- Invariante: pro meter_id höchstens ein Gerät mit removed_at IS NULL
  -- (partieller UNIQUE-Index)

meter_readings
  id            bigserial PK
  device_id     integer NOT NULL REFERENCES meter_devices(id) ON DELETE CASCADE
  value         numeric(14,3) NOT NULL
  taken_at      timestamptz NOT NULL
  source        text NOT NULL DEFAULT 'manual' -- 'manual' | 'ocr' | 'api'
  photo_path    text          -- Beleg-Foto bei OCR-Erfassung
  ocr_confidence real         -- 0..1, nur bei source='ocr'
  entered_by    integer REFERENCES users(id)   -- NULL bei source='api'
  api_key_id    integer REFERENCES meter_api_keys(id) -- nur bei source='api'
  created_at    timestamptz NOT NULL DEFAULT now()
  UNIQUE (device_id, taken_at)

meter_api_keys
  id            serial PK
  meter_id      integer NOT NULL REFERENCES meters(id) ON DELETE CASCADE
  name          text NOT NULL          -- z. B. "Shelly EM Garage"
  key_hash      text NOT NULL          -- SHA-256 des Tokens, Klartext nur einmal angezeigt
  created_by    integer NOT NULL REFERENCES users(id)
  created_at    timestamptz
  last_used_at  timestamptz
  disabled_at   timestamptz

meter_reading_transactions          -- Finance-Verknüpfung, Muster wie
  reading_id     bigint NOT NULL REFERENCES meter_readings(id) ON DELETE CASCADE
  transaction_id bigint NOT NULL REFERENCES finance_transaction(id) ON DELETE CASCADE
  created_at     timestamptz NOT NULL DEFAULT now()
  PRIMARY KEY (reading_id, transaction_id)
```

Migration: nächste freie Nummer (`0121_utility_meters.sql`), **inkl. Eintrag
in `db/migrations/postgres/meta/_journal.json`** (siehe CLAUDE.md).

### 2.2 Validierungsregeln (Service-Schicht)

- Neue Ablesung: `value >= start_value` des Geräts und `value >=` letzte
  Ablesung mit `taken_at <=` neuem Zeitpunkt (monoton pro Gerät). Rückwirkend
  eingefügte Ablesungen müssen auch `<=` der nächst-späteren Ablesung sein.
  Verstoß → `APIError.invalidArgument` mit Details (erwartetes Minimum).
- Gerätewechsel („Ersetzen“): atomarer Vorgang — Abschluss-Ablesung +
  `end_value`/`removed_at` am alten Gerät, neues Gerät mit `installed_at` =
  `removed_at` und frei wählbarem `start_value` (Default 0).
- Absolutstand: `SUM(COALESCE(end_value, letzter Messwert) − start_value)`
  über alle Geräte der Messstelle; als SQL-View oder Query-Helfer, nicht
  materialisiert.

---

## 3. Backend-Service `meter/`

Neuer Encore-Service nach dem Muster von `documents/`:

```
meter/
├── encore.service.ts        // new Service("meter")
├── meter.service.ts         // DB-Logik (Drizzle)
├── meter.ts                 // CRUD-Endpunkte Zähler + Geräte
├── readings.ts              // Ablesungen (manuell), Verlauf, Absolutstand
├── readings-ocr.ts          // Foto-Upload → OCR → Vorschlagswert
├── ingest.ts                // api.raw POST /api/meters/ingest (API-Key-Auth)
├── api-keys.ts              // API-Key-Verwaltung
├── reports.ts               // Verbrauch/Zeit, Perioden-Vergleich
├── reports.service.ts       // generische Bucket-Logik + DB-Reportdaten
├── anomaly.ts               // Anomalie-Erkennung (Cron)
├── finance-link.ts          // Verknüpfung Ablesung ↔ finance_transaction
└── *.test.ts
```

### 3.1 Endpunkte (alle `expose: true, auth: true`, außer Ingest)

| Methode/Pfad | Recht | Zweck |
|---|---|---|
| `GET /meters` | `meters.view` | Liste inkl. aktuellem Gerät, letzter Ablesung, Absolutstand |
| `POST /meters` / `PUT /meters/:id` / `DELETE /meters/:id` | `meters.manage` | Zähler-CRUD (Admin-Seite) |
| `POST /meters/:id/replace-device` | `meters.manage` | Gerätewechsel (atomar, §2.2) |
| `PUT /meters/devices/:id` | `meters.manage` | Gerätedaten korrigieren |
| `DELETE /meters/devices/:id` | `meters.manage` | Neuestes Gerät löschen, solange es keine Ablesungen hat |
| `GET /meters/:id/readings` | `meters.view` | Ablesungen (paginiert, über Gerätegrenzen hinweg, mit Absolutwert-Spalte) |
| `POST /meters/:id/readings` | `meters.read_entry` | Manuelle Ablesung |
| `PUT/DELETE /meters/readings/:id` | `meters.read_entry` (eigene) / `meters.manage` (fremde) | Korrektur/Löschen |
| `POST /meters/:id/readings/ocr` | `meters.read_entry` | Foto hochladen → `{ value, confidence, photoPath }` als Vorschlag; Speichern erfolgt erst mit Bestätigung über `POST readings` |
| `GET/POST/DELETE /meters/:id/api-keys` | `meters.manage` | API-Keys; Klartext-Token nur in der Create-Response |
| `POST /api/meters/ingest` | API-Key (kein User-Auth) | Externe Ablesung |
| `GET /meters/:id/report?granularity=month\|year&from=&to=` | `meters.view` | Generische Verbrauchsreihen (§5) |
| `GET /meters/reports/energy?granularity=month\|year&from=&to=` | `meters.view` | Strom-/PV-Gesamtreport (§5.2) |
| `GET/POST/DELETE /meters/readings/:id/transactions` | `meters.view` + `finance.view` | Finance-Verknüpfung |

### 3.2 Externe Ingestion

`api.raw`-Endpunkt (kein Encore-Auth-Handler), Authentifizierung per
`Authorization: Bearer <token>`; Lookup über `key_hash`. Payload:

```json
{ "value": 1234.5, "takenAt": "2026-07-09T06:00:00Z" }
```

- `takenAt` optional (Default: Serverzeit); der API-Key ist an genau einen
  Zähler gebunden, das Ziel-Gerät ist das aktive Gerät der Messstelle.
- Idempotenz über `UNIQUE (device_id, taken_at)` — Duplikat → 200 mit
  `duplicate: true` (Geräte senden oft doppelt).
- Monotonie-Verstöße → 422; Rate-Limit wie `user/rateLimiter.ts`.
- `last_used_at` am Key aktualisieren.

### 3.3 Foto-OCR

Wiederverwendung der bestehenden ML-Infrastruktur:

1. **Stufe 1 (MVP)**: neuer Endpunkt `/meter-reading` im
   `receipt-ocr-service` (PaddleOCR läuft dort bereits). Zählerstände sind
   gedruckte/mechanische Ziffern — PaddleOCR-Rohtext + Heuristik (längste
   plausible Ziffernfolge, rote Nachkommastellen-Rolle optional
   abschneidbar). Rückgabe `{ value, confidence, rawText }`.
2. **Stufe 2 (Fallback/Qualität)**: bei niedriger Confidence Vision-Prompt
   an den `llm-service` (analog `documents/llm-client.ts`), der aus dem Bild
   den Wert extrahiert.
3. Frontend zeigt den erkannten Wert **immer zur Bestätigung/Korrektur** an —
   OCR speichert nie direkt. Foto wird unter `METERS_DIR` (analog
   `DOCUMENTS_DIR`) abgelegt und an der Ablesung referenziert.

---

## 4. Rechte & Sichtbarkeit

Neue Permission-Keys in `db/seed.ts` (Muster wie Documents/Finance):

| Key | Beschreibung |
|---|---|
| `module.meters` | Enable utility meters module (Navigation) |
| `meters.view` | Zähler, Ablesungen und Reports ansehen |
| `meters.read_entry` | Ablesungen erfassen (manuell/OCR) |
| `meters.manage` | Zähler anlegen/bearbeiten/ersetzen, API-Keys verwalten (Sonderrecht laut Issue) |

Sichtbarkeit: Zähler gehören einem Nutzer (`owner_user_id`) und optional
einer Gruppe (`group_id`, bestehendes `groups`-Konzept aus dem
Documents-Modul). Sichtbar ist ein Zähler für Owner + Gruppenmitglieder;
`meters.manage` wirkt nur auf sichtbare Zähler (kein globaler Admin-Bypass
nötig, Haushalts-Scope reicht).

---

## 5. Reports & Anomalie-Erkennung

### 5.1 Verbrauchsreihen

`GET /meters/:id/report?granularity=month|year&from=&to=`

- Implementierter MVP: Verbrauch pro Bucket = Differenz zwischen zwei
  aufeinanderfolgenden Absolutständen. Das Intervall wird dem Bucket des
  Start-Zeitpunkts zugeordnet. Das entspricht der bisherigen Excel-Logik:
  Ablesung am Monatsanfang beschreibt den Verbrauch bis zur nächsten Ablesung.
- Die Berechnung ist generisch für alle Zählertypen und läuft über den
  Absolutstand der Messstelle, also auch über Gerätewechsel hinweg.
- `from`/`to` filtern Intervalle nach Start-Zeitpunkt.
- Bei Betriebsstundenzählern identisch (Einheit h).
- Noch offen: lineare Interpolation auf exakte Bucket-Grenzen,
  `day`/`week` und Vorjahresvergleich (`compare=previous_year`).

### 5.2 Strom-/PV-Gesamtreport

`GET /meters/reports/energy?granularity=month|year&from=&to=`

Der aggregierte Energie-Report kombiniert die vorhandenen Stromzähler, sofern
sie sichtbar sind. Dafür werden explizite Zählerrollen auf `meters.role`
verwendet; die Report-Logik leitet Rollen nicht aus Anzeigenamen ab.
Der historische Stromimport setzt diese Rollen direkt:

- `grid_import` → Bezug
- `grid_export` → Einspeisung
- `pv_production` → Produktion

Darauf werden je Bucket und für die Gesamtsumme folgende Werte berechnet:

- Eigenverbrauch = Produktion - Einspeisung
- Gesamtverbrauch = Bezug + Eigenverbrauch
- Autarkie = 1 - Bezug / Gesamtverbrauch
- Eigenverbrauchsquote = Eigenverbrauch / Produktion

Zeiträume ohne vollständiges PV-Set (Bezug, Einspeisung und Produktion) werden
im aggregierten Energie-Report ausgelassen, damit alte Vor-PV-Daten nicht in
PV-Kennzahlen und Analysewerte einfließen. Migration `0123_meter_roles`
backfilled bereits importierte historische Zähler einmalig; beim manuellen
Anlegen/Bearbeiten kann die Report-Rolle gesetzt werden.

Nicht Teil der ersten Ausbaustufe: E-Auto, Wärmepumpe, Warmwasser,
Fußbodenheizung, PV-Anteile, Kosten/Preise, Gasvergleich/JAZ.

### 5.3 Anomalie-Erkennung

Muster von `finance/anomaly-detector.ts` übernehmen:

- Cron (täglich) berechnet je Zähler die Tagesverbrauchsrate der letzten
  Ablesungsintervalle; Vergleich gegen rollierendes Mittel/Stddev
  (z-Score) und Saisonalität (gleicher Monat Vorjahr).
- Auffälligkeiten (Verbrauchssprung, Stillstand bei Betriebsstunden,
  rückläufiger Wert durch Tippfehler) landen in einer
  `meter_anomalies`-Tabelle mit Status `pending/confirmed/dismissed` und
  erscheinen im Frontend (Badge + Liste, analog `AnomaliesView.vue`).
- Optionale LLM-Bewertung (Begründungstext) erst in einer späteren Etappe.

---

## 6. Finance-Verknüpfung

- Link-Tabelle `meter_reading_transactions` (§2.1), Muster
  `finance_transaction_document`.
- UI: an der Ablesung „Zahlung verknüpfen“ → Transaktionssuche
  (bestehende Finance-Suche, ACL-gefiltert via `finance.view`).
- Match-Vorschläge (Score aus Datum/Empfänger wie
  `finance/document-matcher.ts`) sind eine spätere Etappe — zunächst rein
  manuelle Verknüpfung.

---

## 7. Frontend (Vue 3 + PrimeVue)

Neue Views unter `frontend/src/views/meters/`, Navigation gated auf
`module.meters`:

| View | Recht | Inhalt |
|---|---|---|
| `MetersView.vue` | `meters.view` | Kachel-/Listenübersicht: Name, Typ-Icon, Standort, letzter Stand + Datum, Absolutstand, Anomalie-Badge; Schnellaktion „Ablesen“ |
| `MeterDetailView.vue` | `meters.view` | Stammdaten, Gerätehistorie (Tabelle wie im Issue-Beispiel), Ablesungsliste, Verbrauchs-Chart mit Vorjahresvergleich, verknüpfte Zahlungen |
| `MeterReadingEntryView.vue` (oder Dialog) | `meters.read_entry` | Wert + Datum/Zeit (Default jetzt), Foto-Button → OCR-Vorschlag mit Confidence, Bestätigen/Korrigieren |
| `MetersAdminView.vue` | `meters.manage` | Zähler-CRUD, Gerät ersetzen (Wizard: Endstand alt → Startwert neu), API-Key-Verwaltung |

Design: nur semantische PrimeVue-CSS-Variablen (CSS-Style-Guide),
Datums-Handling über `frontend/src/utils/dateFormat.ts`
(`toLocalIsoDate`/`parseLocalDate`). Charts wie in den Finance-Views.
Storybook-Stories für Übersicht + Erfassungsdialog.

---

## 8. Etappen

| # | Titel | Inhalt | Abhängig von |
|---|---|---|---|
| 1 | DB + Rechte | Migration `0121` + `_journal.json`, Schema in `db/schema.ts`, Seed-Permissions, Service-Skelett `meter/` | — |
| 2 | Zähler-CRUD + Geräte | `meter.ts`, Ersetzen-Flow, Admin-View, Tests (Monotonie, Gerätewechsel-Invarianten) | 1 |
| 3 | Manuelle Ablesungen | `readings.ts`, Absolutstand-Berechnung, Übersichts- + Detail-View, Erfassungsdialog | 2 |
| 4 | Foto-OCR | `receipt-ocr-service`-Endpunkt `/meter-reading`, `readings-ocr.ts`, Foto-Ablage, Bestätigungs-UI | 3 |
| 5 | API-Ingestion | `meter_api_keys`, `ingest.ts` (Bearer, Idempotenz, Rate-Limit), Key-Verwaltung in Admin-View | 3 |
| 6 | Reports | MVP umgesetzt: `reports.ts`/`reports.service.ts`, Monats-/Jahres-Buckets aus Ableseintervallen, Chart + Tabelle in Detail-View, aggregierter Strom-/PV-Gesamtreport in der Übersicht, explizite Zählerrollen. Offen: Interpolation, Day/Week, Vorjahresvergleich. | 3 |
| 7 | Anomalien | Cron + `meter_anomalies`, Badge/Liste im Frontend | 6 |
| 8 | Finance-Link | Link-Tabelle, Endpunkte, UI an Ablesung/Transaktion | 3 (+ Finance) |

MVP = Etappen 1–3; jede Etappe wird einzeln getestet (`npm run test` vor
jedem Push) und ist unabhängig deploybar.

---

## 9. Tests (je Etappe, Vitest)

- **Monotonie**: rückwirkende/zukünftige Ablesungen, Grenzfälle exakt gleicher
  Wert, Verstoß → `invalid_argument`.
- **Gerätewechsel**: Absolutstand vor/nach Wechsel (Issue-Beispiel 102→734,
  neu ab 3), nur ein aktives Gerät pro Messstelle.
- **Ingest**: gültiger/ungültiger/deaktivierter Key, Duplikat (idempotent),
  Monotonie-422, `last_used_at`.
- **Reports**: Bucketbildung über Gerätewechsel, leere Zeiträume,
  Filtergrenzen; später Interpolation und Vorjahresvergleich.
- **Rechte**: Sichtbarkeit Owner/Gruppe, `meters.manage` erforderlich für
  CRUD/Keys.
- **OCR**: Client gemockt (Muster `documents/llm-client.test.ts`),
  Confidence-Weitergabe, kein Auto-Save.
