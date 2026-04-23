# Finance — Frontend: Views, Stores, Wireframes

Ziel: Das Finanz-Modul bekommt im Vue/PrimeVue-Frontend von fk-encore
eine eigene Navigationssektion mit 13 Views. Der Legacy-Finanzkraft-
Stack (Vue 3, PrimeVue, Pinia) matcht 1:1, sodass Views *inhaltlich*
übernommen werden können — der Code wird jedoch neu geschrieben gegen
den fk-encore-API-Helper und den bestehenden User-Store.

Entfallen gegenüber Legacy: `CategoriesView`, `TransactionRulesView`.
Neu gegenüber Legacy: `AccountAssignmentView`, `SyncScheduleView`,
`AnalysisView`.

Status: Feature-Plan, Umsetzung in Etappen.

---

## 1. Stack und Konventionen

- **Vue 3.5** Composition API, `<script setup lang="ts">`.
- **PrimeVue 4.5** für UI-Komponenten; Theme folgt dem bestehenden
  fk-encore-Theme.
- **Pinia 3** für State, Stores in `src/stores/finance/`.
- **Vue Router 4**, Routen unter `/finance/*`.
- **TypeScript strict**, Interfaces für API-Responses aus dem
  generierten Encore-Client.
- **API-Zugriff**: über den bestehenden fk-encore-API-Helper (nicht
  axios, nicht eigenes Fetch-Wrapping).
- **Auth**: über den bestehenden User-Store; kein eigener Auth-Layer im
  Modul. Permissions werden via `useAuth().hasPermission("finance.view")`
  abgefragt, parallel zu den Backend-Checks.

---

## 2. Pinia-Stores

| Store | Zweck |
|---|---|
| `useAccountsStore` | Listen- und Detail-Cache, Permissions-aware Filter |
| `useTransactionsStore` | paginierte Liste pro Konto, Tag-Filter, optimistische Updates |
| `useBankcontactsStore` | Bankkontakte inkl. offenem TAN-Dialog-State |
| `useTagsStore` | globale Tag-Liste, getrennt nach `source='user'` und `source='ai'` |
| `useSyncScheduleStore` | `finance_bankcontact.sync_times` laden/speichern |
| `useFinancePrefsStore` | `finance_system_pref` (globale Einstellungen) |

Jeder Store hält seinen Loading- und Error-State; Komponenten rufen nur
Store-Actions, nie direkt den API-Helper.

---

## 3. Views

| View | Route | Permission | Zweck |
|---|---|---|---|
| `BankcontactsView` | `/finance/bankcontacts` | `finance.accounts.manage` | Liste + Anlegen |
| `BankcontactDetailView` | `/finance/bankcontacts/:id` | `finance.accounts.manage` | Edit, Credentials setzen, Sync-Trigger |
| `TanDialog` (Modal) | — | `finance.accounts.manage` | TAN-Eingabe mit Countdown |
| `AccountsView` | `/finance/accounts` | `finance.view` | Konten-Liste (ACL-gefiltert) |
| `AccountDetailView` | `/finance/accounts/:id` | `finance.view` | Saldo-Historie, Transaktionen |
| `AccountAssignmentView` | `/finance/admin/access` | `finance.admin` | User↔Konto ACL (neu) |
| `TransactionsView` | `/finance/transactions` | `finance.view` | Liste + Tag-Filter |
| `TransactionDetailView` | `/finance/transactions/:id` | `finance.view` | Edit, Tag-Vorschläge annehmen |
| `TransactionNewView` | `/finance/transactions/new` | `finance.view` | manuelle Buchung |
| `BatchTagView` | `/finance/tags/batch` | `finance.view` | Mehrfach-Tagging auf Auswahl |
| `SyncScheduleView` | `/finance/bankcontacts/:id/schedule` | `finance.accounts.manage` | UI-Cron pro Bankkontakt (neu) |
| `AdminImportView` | `/finance/admin/import` | `finance.admin` | Finanzkraft-JSON-Upload |
| `AnalysisView` | `/finance/analysis` | `finance.view` | Natural-Language-Queries (neu) |

Router-Guards prüfen die jeweilige Permission und leiten bei fehlender
Berechtigung auf den Dashboard-Root zurück — analog zu den bestehenden
Photos/Documents-Routen.

---

## 4. Wireframes

### 4.1 `TanDialog`

Wird als PrimeVue-Dialog über jede Ansicht gelegt, die einen Sync
auslöst. Countdown bindet gegen `expires_at` aus der TAN-Session.

```
+---------------------------------------------+
| TAN erforderlich — Sparkasse XY             |
+---------------------------------------------+
| Herausforderung:                            |
|   Bitte bestätigen Sie die Anmeldung        |
|   in der pushTAN-App Ihrer Sparkasse.       |
|                                             |
| TAN:  [ _ _ _ _ _ _ ]                       |
|                                             |
| Gültig noch:  09:42                         |
|                                             |
|                   [Abbrechen]  [Bestätigen] |
+---------------------------------------------+
```

Flow (siehe `finance-fints-integration.md` §4): bei `409` aus
`POST /finance/statements` öffnet die UI den Dialog mit `tanReference`
und `challenge`; Submit ruft `POST /finance/tan-sessions/complete`.

### 4.2 `AnalysisView`

```
+--------------------------------------------------------+
| Analyse                                                |
+--------------------------------------------------------+
| Frage:  [ Was habe ich im Italien-Urlaub 2024 …   ] 🔍 |
+--------------------------------------------------------+
| Erkannt:                                               |
|   Tags:      [urlaub ✕] [italien-2024 ✕]  + hinzufügen |
|   Operator:  (•) AND   ( ) OR                          |
|   Zeitraum:  [2024-06-01] — [2024-09-30]               |
|                                    [Aktualisieren]     |
+--------------------------------------------------------+
| Summe:     2.341,50 €   Anzahl: 47   Ø:  49,82 €       |
|                                                        |
| [ Monats-Balken-Chart (PrimeVue Chart)              ]  |
|                                                        |
| Top-Gegenseiten:                                       |
|   Trattoria Da Luigi      412,00 €   (14 Buchungen)    |
|   Hotel Firenze           890,00 €   ( 3 Buchungen)    |
|   Trenitalia              234,00 €   ( 8 Buchungen)    |
|                                                        |
|                     [Als CSV exportieren (optional)]   |
+--------------------------------------------------------+
```

AST-Chips sind editierbar — User kann Tags entfernen/hinzufügen,
Operator umschalten, Zeitraum anpassen, dann „Aktualisieren". Nur der
initiale Parse ruft den `llm-service`; Editierungen laufen rein als
SQL gegen das Backend.

### 4.3 `SyncScheduleView`

```
+--------------------------------------------------------+
| Sync-Zeiten — Sparkasse XY                             |
+--------------------------------------------------------+
| Zeitzone:  [ Europe/Berlin ▾ ]                         |
|                                                        |
| Slots:                                                 |
|   Mo Di Mi Do Fr       06:25   [Entfernen]             |
|   Mo Di Mi Do Fr       15:25   [Entfernen]             |
|   Sa                   08:00   [Entfernen]             |
|                                                        |
|   + Slot hinzufügen                                    |
|     Wochentage: [ ]Mo [ ]Di … [ ]So                    |
|     Zeit:       [ 08:00 ]                              |
|     [Hinzufügen]                                       |
|                                                        |
|                       [Abbrechen]  [Speichern]         |
+--------------------------------------------------------+
```

Speichern schreibt `finance_bankcontact.sync_times` als JSON-Array (siehe
`finance-data-model.md` §2.3). Die UI zeigt die nächste effektive
Ausführung relativ zu `now()` in der aktuellen Zeitzone — inklusive
DST-Anpassung.

### 4.4 `AccountAssignmentView`

```
+--------------------------------------------------------+
| Konto-Zugriff  (nur finance.admin)                     |
+--------------------------------------------------------+
| Konto:  [ DE12 … 3456  Girokonto Sparkasse XY  ▾ ]     |
+--------------------------------------------------------+
| Zugriffsberechtigte:                                   |
|   Alice Müller     [ read  ▾ ]   [Entfernen]           |
|   Bob Schmidt      [ write ▾ ]   [Entfernen]           |
|                                                        |
|   + User hinzufügen:                                   |
|     [ User suchen …          ]   [ read ▾ ]   [+]      |
|                                                        |
|                                      [Speichern]       |
+--------------------------------------------------------+
```

Schreibt auf `finance_account_access`. Das Dropdown für Users zieht aus
dem bestehenden User-Endpoint (keine eigene Finance-User-Liste).
Bestehende Zeilen des gewählten Kontos werden vor dem Speichern als
Diff gegen die neue Liste berechnet (Inserts / Deletes / Level-Updates).

### 4.5 `BankcontactsView`

Einstiegsliste für Nutzer mit `finance.accounts.manage`.

```
+-----------------------------------------------------------------------+
| Bankkontakte                                     [+ Neu anlegen]      |
+-----------------------------------------------------------------------+
| Name            BLZ       Login            Letzter Sync       Status  |
|-----------------------------------------------------------------------|
| Sparkasse XY    12345678  max.mustermann   2026-04-23 06:25   ✓ OK    |
| ING             50010517  123456789        2026-04-22 15:25   ⚠ TAN   |
| DKB             12030000  98765432         —                  ⛔ Fehler|
+-----------------------------------------------------------------------+
| Filter: [ Status: Alle ▾ ]      Zeile klicken → Detailansicht         |
+-----------------------------------------------------------------------+
```

Status-Spalte: `last_sync_status` (`OK`, `tan-required`, `error`) plus
passendes Icon. Die Zeilenfarbe signalisiert Probleme (gelb für
`tan-required`, rot für `error`). Klick öffnet `BankcontactDetailView`.

### 4.6 `BankcontactDetailView`

Formular-View für Stammdaten, Credentials und Sync-Aktionen. Teilt sich
in drei klar getrennte Kartenbereiche.

```
+-----------------------------------------------------------------------+
| Bankkontakt: Sparkasse XY                              [Zurück]       |
+-----------------------------------------------------------------------+
| Stammdaten                                                            |
|   Name:         [ Sparkasse XY                             ]          |
|   BLZ:          [ 12345678 ]                                          |
|   Login:        [ max.mustermann                           ]          |
|   Server-URL:   [ https://hbci.sparkasse-xy.de             ]          |
|   TAN-Methode:  [ pushTAN ▾ ]      [TAN-Methoden neu laden]           |
+-----------------------------------------------------------------------+
| Credentials                                                           |
|   Passwort/PIN: [ ············ ]   [Neu setzen]                       |
|   Status: ✓ verschlüsselt gespeichert  (zuletzt 2026-04-23)           |
+-----------------------------------------------------------------------+
| Sync                                                                  |
|   Letzter Sync:  2026-04-23 06:25 — OK, 3 Umsätze                     |
|   [Sync jetzt]          [Sync-Zeiten bearbeiten]                      |
+-----------------------------------------------------------------------+
|                           [Abbrechen]           [Speichern]           |
+-----------------------------------------------------------------------+
```

- Der `Passwort/PIN`-Input sendet den Klartext ausschließlich an den
  Set-Credentials-Endpoint, der `encryption.ts` (siehe
  `finance-fints-integration.md` §3) nutzt; im Store bleibt nur der
  boolesche „Status gespeichert"-Flag.
- `Sync jetzt` ruft `POST /finance/statements`; bei `409` öffnet sich
  der `TanDialog` (§4.1).
- `Sync-Zeiten bearbeiten` navigiert zu `SyncScheduleView` (§4.3) für
  denselben Bankkontakt.
- `TAN-Methoden neu laden` startet einen kurzen FinTS-Dialog nur zum
  Lesen der verfügbaren Verfahren und aktualisiert das Dropdown.

### 4.7 `AccountsView`

Die einzige View, die jeder `finance.view`-User sieht. ACL-gefiltert:
nur Konten, auf denen der User einen `finance_account_access`-Eintrag
hat (oder alle, wenn er `finance.admin` besitzt).

```
+-----------------------------------------------------------------------+
| Konten                                     [ Bankkontakt: Alle ▾ ]    |
+-----------------------------------------------------------------------+
| Label             IBAN              Währ.  Saldo        Letzter Umsatz|
|-----------------------------------------------------------------------|
| Giro Sparkasse    DE12 … 3456       EUR     2.341,50 €  2026-04-22    |
| Tagesgeld ING     DE50 … 0517       EUR    12.000,00 €  2026-04-15    |
| Depot DKB         DE12 … 0000       EUR    45.678,90 €  2026-04-10    |
+-----------------------------------------------------------------------+
| Inaktive Konten anzeigen: [ ]     Zeile klicken → AccountDetailView   |
+-----------------------------------------------------------------------+
```

Der aktuelle Saldo kommt aus dem jüngsten Eintrag in
`finance_account_balance`. Kein Inline-Editing — alle Änderungen laufen
über `AccountDetailView` bzw. `AccountAssignmentView`.

### 4.8 `AccountDetailView`

Zweigeteilt: oben Saldo-Verlauf, unten Umsatz-Liste (mit derselben
Komponente wie `TransactionsView`, vorausgewähltes Konto).

```
+----------------------------------------------------------------------+
| Giro Sparkasse XY — DE12 … 3456                           [Zurück]   |
+----------------------------------------------------------------------+
| Aktueller Saldo: 2.341,50 €      Stand: 2026-04-22 06:25             |
|                                                                      |
| [ Saldo-Verlauf (PrimeVue Line Chart, 12 Monate)                  ]  |
|                                                                      |
+----------------------------------------------------------------------+
| Umsätze                      [Filter ▾]   [+ Manuelle Buchung]       |
|----------------------------------------------------------------------|
| Datum       Verwendungszweck   Gegenseite      Betrag       Tags     |
| 2026-04-22  Miete April        B. Vermieter    -850,00 €    [miete]  |
| 2026-04-20  Supermarkt         REWE              -47,32 €   [alltag] |
| 2026-04-15  Gehalt April       AG GmbH        +3.800,00 €   [gehalt] |
+----------------------------------------------------------------------+
| Zeitraum:  [ 12 Monate ▾ ]            Seite 1 von 14    < 1 2 3 >    |
+----------------------------------------------------------------------+
```

- Saldo-Chart-Zeitraum-Dropdown reused `finance_timespan`-Presets (siehe
  `finance-data-model.md` §2.2).
- `+ Manuelle Buchung` öffnet `TransactionNewView` mit vorausgewähltem
  Konto — nur sichtbar, wenn der User `level='write'` auf dem Konto
  hält.
- Zeilen-Klick führt zu `TransactionDetailView`.

---

## 5. Kurzbeschreibung der übrigen Views

- **`TransactionsView`**: DataTable mit Virtual-Scroll, Filter-Leiste
  (Datum, Tags, Betragsrange, Gegenseite). Row-Aktion öffnet
  `TransactionDetailView`.
- **`TransactionDetailView`**: Buchungsdatum, Betrag, Verwendungszweck,
  Gegenseite + Tag-Editor. KI-Vorschläge erscheinen als graue Chips
  (Badge „KI", zusätzlich Confidence-Balken); Klick promoted sie auf
  User-Tag (siehe `finance-tagging-and-ai.md` §3). User-Tags sind
  blaue Chips mit `×`-Button.
- **`TransactionNewView`**: Formular für manuelle Buchung auf einem
  Konto mit `finance.view`-Zugriff und `level='write'`. Pflichtfelder
  Datum, Betrag, Verwendungszweck.
- **`BatchTagView`**: Wird aus der `TransactionsView` per „Tags auf
  Auswahl anwenden" geöffnet; zeigt die Selection und einen
  Multi-Select für Tags, `Apply` schreibt gesammelt.
- **`AdminImportView`**: File-Upload (accept=".json"), nach Submit
  Fortschrittsanzeige pro Stage (Bankkontakte → … → Joins), am Ende
  Tabelle mit Counts + optional Download der Validierungsfehler
  (JSON).

---

## 6. Interaktions-Besonderheiten

- **TAN-Flow**: Die `useBankcontactsStore`-Action `syncNow(id)` kapselt
  das Verhalten bei `409 Conflict` aus `POST /finance/statements`:
  öffnet `TanDialog`, blockt weitere Sync-Trigger für diesen Bankkontakt
  bis `complete` oder Abbruch. Push-Notifications (aus dem Cron, siehe
  `finance-fints-integration.md` §5.1) führen im Foreground-Tab
  automatisch zu einem Store-Refresh, damit der User den Dialog direkt
  sieht.
- **KI-Tag-Promotion**: `TransactionDetailView` schickt beim Klick auf
  einen AI-Chip `POST /finance/transactions/:id/tags/promote` mit dem
  Tag-Namen. Der Store aktualisiert optimistisch; bei Fehler Rollback.
- **Analysis**: `AnalysisView` sendet die Freitext-Frage nur beim
  initialen Parse; Edits am AST lösen einen reinen Aggregations-Call aus
  (`POST /finance/analysis/aggregate`), ohne den LLM erneut zu befragen.
- **Permissions-UI-Konsistenz**: Menüpunkte und Buttons sind hinter
  `hasPermission(...)` gewrapped, aber die endgültige Durchsetzung liegt
  im Backend (`requirePermission(...)` in jedem Handler).

---

## 7. Referenzen

| Stelle | Wofür |
|---|---|
| bestehende Photos-/Documents-Views | API-Helper-Nutzung, Store-Pattern |
| `finance-fints-integration.md` §4 | `TanDialog`-Backend-Kontrakt |
| `finance-tagging-and-ai.md` §3–§4 | KI-Chips, `AnalysisView`-Backend |
| `finance-data-import.md` | `AdminImportView`-Backend |
| `finance-data-model.md` §5 | Permissions für Router-Guards |

---

## 8. Offene Punkte

- **CSV-Export in `AnalysisView`**: wirklich MVP oder erst später?
- **Diff-Preview in `AccountAssignmentView`**: brauchen wir eine
  Bestätigungsansicht („+ Alice read, − Bob, Charlie read→write")
  vor dem Speichern?
- **Push-im-Foreground-Tab**: sollen wir beim Eintreffen einer TAN-
  Push-Benachrichtigung automatisch den `TanDialog` öffnen, oder nur
  einen dezenten Hinweis im Menü zeigen?
- **Saldo-Chart-Zeitraum**: Default 12 Monate? Oder an `finance_timespan`
  gekoppelt?
