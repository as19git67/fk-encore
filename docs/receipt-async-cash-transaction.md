# Etappenplan: Asynchrone Beleg-Erkennung mit automatischer Bar-Transaktion

## Ziel & UX

Heute blockiert das Beleg-Foto das Erfassungsformular bis zu **130 s**, während das
`receipt-ocr-service` synchron Betrag/Datum/Posten extrahiert
(`extractReceiptOcr` in `TransactionNewView.vue:200`). Das soll weg.

**Gewünschter Ablauf:**

1. Beleg fotografieren → Belegbild wird als Dokument gespeichert, der Nutzer ist
   sofort wieder frei. **Es entsteht hier noch keine Transaktion.**
2. Die Beleg-Erkennung (Kern-OCR + Einzelposten) läuft **im Hintergrund**.
3. **Sobald die Metadaten vorliegen**, wird **vollautomatisch** eine
   Bar-Transaktion angelegt — **ohne Zustimmung und ohne eigenen Review-Schritt** —
   bereits befüllt mit Betrag/Datum/Store/Posten und mit dem Beleg verknüpft.
4. Der Nutzer wird per Realtime-Notifikation informiert. Die Transaktion ist von
   da an eine **ganz normale, bearbeitbare Bar-Buchung**: korrigieren kann er
   sie jederzeit über die bestehende Bearbeitung — das ist aber freiwillig und
   kein erzwungener Schritt.

## Architekturentscheidung

Variante **B** (Background-Pipeline, kein Vorab-Bestätigungsschritt). Die
Transaktion wird **erst mit vorhandenen Metadaten** erstellt — also vom
Hintergrund-Worker nach erfolgreicher OCR, nicht beim Fotografieren — und zwar
**vollautomatisch, ohne Zustimmung und ohne dedizierten Review-/Bestätigungs-
Flow**. Es entsteht eine reguläre Bar-Transaktion; eine spätere Korrektur läuft
über die normale Transaktionsbearbeitung, nicht über ein eigenes Review-UI.

### Folge dieser Entscheidung (großer Vorteil)

Weil die Transaktion **immer** schon einen echten Betrag hat, entfallen die zwei
größten Komplexitäten der ursprünglichen Idee:

- **Kein Platzhalter-`amount`** → die Sperre `amount === "0.00"`
  (`transactions.ts:493`) ist kein Thema; wir können den regulären
  Erstell-Pfad nutzen.
- **Kein Saldo-Ausschluss** nötig → es gibt nie eine pending-Transaktion, die
  Kontostand/Auswertungen verfälschen könnte.

### Vorhandene Bausteine (werden wiederverwendet)

| Baustein | Ort | Rolle |
| --- | --- | --- |
| Beleg-Upload + Background-Scan | `documents/documents.ts` (`receipt-capture`), `scan-worker.ts`, `document-ops.ts` | Speichert Dokument, stößt Verarbeitung an |
| Realtime-Events | `finance/document-match.service.ts:104` (`realtime.publishEvent`, `receipt.enriched`) | Notifikation an den Nutzer |
| Transaktions↔Dokument-Link | `finance_transaction.receipt_document_id` (`db/schema.ts:1500`) | Verknüpfung besteht schon |
| Enrichment-Diff | `computeReceiptEnrichment` (`document-match.service.ts:57`) | Diff Beleg ↔ Transaktion für Review |
| receipt-ocr-service | `receipt-ocr-service/main.py`, Client `documents/receipt-ocr-client.ts` | Kern-OCR + Items |

### Was offen bleibt: der „kein Betrag erkannt"-Fall

Wenn die OCR keinen verlässlichen Betrag liefert, soll **keine** Transaktion
automatisch entstehen (sonst stünde eine falsche Buchung im Hauptbuch).
Stattdessen: Dokument als „erkannt, aber unvollständig" markieren und den Nutzer
notifizieren, damit er manuell bucht. Siehe Etappe 4.

---

## Etappen

Jede Etappe ist eigenständig lauffähig & testbar. **Test-Pflicht vor jedem
Push** (`npm run test`, alle grün). Bei neuen/umbenannten Migrationen immer
`db/migrations/postgres/meta/_journal.json` mitpflegen.

### Etappe 1 — Datenmodell

**Ziel:** Persistenz der strukturierten Extraktion + Idempotenz-Anker +
gewähltes Konto.

- **Separate Tabelle `document_receipt_extraction`** (entschieden): hält
  Betrag/Datum/Store/Items/Confidence aus der schlanken `documents`-Zeile
  heraus. 1:1 zum Dokument.
- **Gewähltes Cash-Konto persistieren:** das beim Fotografieren gewählte Konto
  (Etappe 2) muss bis zur späteren Hintergrund-Buchung erhalten bleiben —
  Spalte `receipt_account_id` am Dokument (oder an der Extraktions-/Capture-
  Zeile), Pflicht für den Auto-Buchungs-Pfad.
- Idempotenz: sicherstellen, dass pro Beleg höchstens **eine** auto-erzeugte
  Transaktion entsteht (Worker ist at-least-once). Variante: partieller
  Unique-Index auf `finance_transaction.receipt_document_id` für auto-erzeugte
  Zeilen, oder Marker `receipt_transaction_id` am Dokument.
- Statusmarker am Dokument für den OCR-Fortschritt
  (`receipt_ocr_state: 'pending' | 'booked' | 'incomplete' | 'failed'`),
  damit Notifikation & UI den Zustand kennen.
- Drizzle-Migration unter `db/migrations/postgres/`, `_journal.json` ergänzen.

**Done:** Schema migriert, Tests grün, keine Verhaltensänderung.

### Etappe 2 — Capture entkoppeln (nur speichern, nicht erkennen)

**Ziel:** Foto blockiert nicht mehr; OCR wandert in den Hintergrund.

- `receipt-capture`-Pfad bleibt: Bild als Dokument speichern (schnell, 201) und
  Background-Verarbeitung anstoßen. Der synchrone `extractReceiptOcr`-Aufruf
  wird aus dem Capture-Flow entfernt.
- **Konto-Wahl beim Fotografieren (entschieden):** der Foto-Dialog lässt den
  Nutzer das Cash-Konto wählen, bevor er den Beleg aufnimmt. Das gewählte
  `account_id` geht als Pflichtparameter an den Capture-Endpoint und wird am
  Dokument persistiert (Etappe 1), damit die spätere Hintergrund-Buchung weiß,
  wohin sie bucht. Vorbelegung mit zuletzt genutztem Cash-Konto ist erlaubt,
  aber der Nutzer kann umstellen.

**Done:** Capture liefert sofort zurück; kein synchrones OCR mehr im Request;
gewähltes Konto ist gespeichert.

### Etappe 3 — Background-OCR im Worker

**Ziel:** Erkennung läuft asynchron und persistiert das Ergebnis.

- In der Dokument-Scan-Pipeline (`scan-worker.ts` / `document-ops.ts`) für
  Belege (mime/Priorität) `receipt-ocr-client` aufrufen: `extractReceipt` +
  `extractReceiptItems`.
- Ergebnis in die Extraktions-Persistenz (Etappe 1) schreiben,
  Dokument-Status auf den passenden `receipt_ocr_state` setzen.

**Done:** Nach Capture liegen die strukturierten OCR-Felder am Dokument vor.

### Etappe 4 — Automatische Buchung aus Metadaten

**Ziel:** Aus dem OCR-Ergebnis entsteht die Bar-Transaktion.

- **Verlässlicher Betrag = `> 0 und <= 999` (entschieden):** nur in diesem
  Bereich wird automatisch gebucht. `amount <= 0` oder `> 999` gilt als nicht
  verlässlich → kein Auto-Buchen.
- Wenn verlässlicher Betrag vorliegt: Bar-Transaktion über den regulären
  Erstell-Pfad auf dem gewählten `receipt_account_id` anlegen — `amount`,
  `booking_date`, `counterparty` (=store), `purpose` (=Items-Notiz),
  `receipt_document_id` gesetzt; Status `booked`.
- **Buchungsdatum (entschieden):** erkanntes Belegdatum, Fallback heute, und
  **niemals neuer als heute**. „Heute" ist die *lokale* Sicht des Nutzers, nicht
  Server-UTC — daher die Date-only-Helfer aus `frontend/src/utils/dateFormat.ts`
  (`toLocalIsoDate`/`parseLocalDate`) verwenden bzw. das Clamping serverseitig so
  umsetzen, dass eine am selben Tag aufgenommene Quittung nicht durch eine
  UTC-Verschiebung fälschlich als „morgen" abgelehnt wird (Timezone
  Frontend↔Server beachten).
- Wenn **kein verlässlicher** Betrag: **keine** Transaktion anlegen,
  Dokument-Status `incomplete`, Notifikation „Beleg erkannt — Betrag bitte
  ergänzen".
- Wenn das OCR-Service **down** ist: Job zurückstellen/retry (wie bestehende
  LLM-Backoff-Logik im Worker), kein Fehlschlag.
- Idempotent über den Anker aus Etappe 1.

**Done:** Erfolgreiche OCR erzeugt automatisch eine korrekte Bar-Transaktion;
Failure-/Incomplete-Pfade getestet.

### Etappe 5 — Realtime-Notifikation

**Ziel:** Eine einzige Notifikation weist darauf hin, dass eine neue Buchung
existiert — mehr nicht. Kein Inbox, kein Badge, kein Review-Aufbau.

- Neues Event analog `receipt.enriched`:
  `receipt.booked` `{ transaction_id, document_id, amount, store }`.
- Frontend: **eine** Benachrichtigung „Neue Buchung aus Beleg" über den
  bestehenden Notifikations-Mechanismus. Antippen führt zur normalen
  Transaktionsansicht — als bequemer Sprung, nicht als Pflicht-Schritt.
- Sonderfall „kein Betrag erkannt" (Etappe 4): ebenfalls nur eine Notifikation
  „Beleg erkannt — Betrag bitte ergänzen", die zur manuellen Erfassung führt.

**Done:** Genau eine Notifikation pro Beleg-Ergebnis erreicht den Client.

### Etappe 6 — Frontend-Capture-Flow umbauen

**Ziel:** Kein synchrones Warten mehr.

- `TransactionNewView.vue`: synchronen `extractReceiptOcr`/`extractReceiptItems`
  durch den entkoppelten Capture (Etappe 2) ersetzen. Nach dem Foto kehrt der
  Nutzer sofort zurück; keine 130-s-Blockade.
- Einstiegspunkt fürs reine Beleg-Fotografieren (ohne sofort ins Formular zu
  müssen), da die Transaktion ohnehin automatisch entsteht.

**Done:** Foto blockiert die UI nicht mehr; manuelle Erfassung weiter möglich.

### Etappe 7 — Beleg an der fertigen Transaktion sichtbar machen

**Ziel:** Kein eigener Review-/Bestätigungs-Flow — nur Transparenz.

- In `TransactionDetailView` den verknüpften Beleg + erkannte Items anzeigen
  (read-only Verknüpfung). Korrektur erfolgt über die **bestehende** Bearbeitung
  einer Cash-Transaktion — keine separate „bestätigen/übernehmen"-Mechanik.
- Optional: dezente Markierung „aus Beleg erkannt" + niedrige `ocr_confidence`
  als Hinweis, aber ohne Aktion zu erzwingen.

**Done:** Beleg/Items sind an der Transaktion einsehbar; Korrektur nur über den
normalen Bearbeiten-Pfad, kein Extra-Review.

### Etappe 8 — Aufräumen, Doku, Migration

- Tote synchrone OCR-Endpoints (`/documents/receipt-ocr`,
  `/documents/receipt-ocr-items`) deprecaten/entfernen, sobald Etappe 6 sie
  ablöst.
- Doku (`docs/finance-frontend.md`, `finance-tagging-and-ai.md`) aktualisieren.
- End-to-end-Test über den ganzen Flow.

---

## Getroffene Entscheidungen

1. **Persistenz der Extraktion:** separate Tabelle
   `document_receipt_extraction`.
2. **Konto-Auswahl:** der Nutzer wählt das Cash-Konto **beim Fotografieren**;
   das gewählte Konto wird am Dokument persistiert und steuert die spätere
   Hintergrund-Buchung.
3. **Schwelle „verlässlicher Betrag":** automatisch buchen nur bei
   `amount > 0 und <= 999`; sonst `incomplete` + Notifikation.
4. **Buchungsdatum:** erkanntes Belegdatum, Fallback heute, niemals neuer als
   heute — mit korrekter Timezone-Behandlung Frontend↔Server (lokales „heute").
