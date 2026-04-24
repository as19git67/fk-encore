# Finance — Etappen-Roadmap

Reihenfolge und Scope der Umsetzungsschritte nach Abschluss von Etappe 0
(Architektur-Dokumentation). Jede Etappe nennt ihr Liefer-Artefakt,
die leitende Architektur-Doku, Test-Schwerpunkte und Abhängigkeiten.

Status: Feature-Plan, Umsetzung startet mit Etappe 1.

---

## 0. Übersicht

| # | Titel | Leitende Doku | MVP? |
|---|---|---|---|
| 0 | Architektur-Dokumentation | alle 7 Dokus | ✓ (abgeschlossen) |
| 1 | DB-Schema + Migration | `finance-data-model.md` | ✓ |
| 2 | Credential-Crypto + FinTS-Client | `finance-fints-integration.md` §1–§3 | ✓ |
| 3 | Bankkontakte-CRUD + TAN-Flow | `finance-fints-integration.md` §4 + `finance-frontend.md` §4.1/§4.5/§4.6 | ✓ |
| 4 | Konten + ACL | `finance-data-model.md` §5 + `finance-frontend.md` §4.4/§4.7/§4.8 | ✓ |
| 5 | Transaktionen + KI-Tagging | `finance-tagging-and-ai.md` §3 + `finance-frontend.md` §4.9–§4.12 | ✓ |
| 6 | Sync-Cron + Push | `finance-fints-integration.md` §5 + `finance-frontend.md` §4.3 | ✓ |
| 7 | Datenimport | `finance-data-import.md` + `finance-frontend.md` §4.13 | ✓ |
| 8 | Frontend-Gesamtbild | `finance-frontend.md` §1–§5 | ✓ |
| 9 | Analyse-Abfragen | `finance-tagging-and-ai.md` §4 + `finance-frontend.md` §4.2 | post-MVP |

MVP = Etappen 1–8. Etappe 9 folgt nach MVP.

---

## 1. Etappe 1 — DB-Schema + Migration

**Ziel**: Migration `0043_finance_initial.sql` produktiv einsetzbar,
Drizzle-Schema importierbar, Permissions seeded.

**Neue Dateien**:
- `db/migrations/postgres/0043_finance_initial.sql` (Drizzle-generiert)
- Ergänzung in `db/schema.ts` (alle Tabellen + Enums aus
  `finance-data-model.md` §2)
- Ergänzung in `db/seed.ts` (4 neue Permissions + Admin-Exclusion)

**Tests**: Schema-Konsistenz (`drizzle-kit check`), Migrations-Roundtrip
gegen frische `encore_test`-DB.

**Abhängigkeiten**: keine.

---

## 2. Etappe 2 — Credential-Crypto + FinTS-Client

**Ziel**: Credentials verschlüsselt ablegen, `lib-fints` eingebunden,
`runSynchronize` als testbare Funktion.

**Neue Dateien**:
- `finance/encore.service.ts`, `finance/types.ts`
- `finance/encryption.ts` + `.test.ts`
- `finance/fints-client.ts` + `.test.ts`
- `package.json` ergänzt um `lib-fints`
- `vitest.setup.ts` ergänzt um einen Mock für `encore.dev/config`,
  damit Module, die Secrets beim Import instanziieren, in Tests
  nicht am Fehler der fehlenden Encore-Runtime scheitern
- Drei Encore-Secrets lokal + in CI gesetzt:
  - `FinanceCredentialsKey` — 32 Byte base64, AES-256-GCM-Key
  - `FinanceFintsProductId` — ZKA-registrierte Produkt-ID (lokal
    Dummy ok, Prod Pflicht)
  - `FinanceFintsProductVersion` — semantische Versionsnummer des
    Finance-Moduls

**Tests**: Roundtrip + Tampering (§2.1), FinTS-Wrapper-Logik mit
gemocktem `lib-fints` (§2.2 aus `finance-testing.md`).

**Abhängigkeiten**: Etappe 1 (Schema vorhanden, aber noch keine
Endpoints nötig).

---

## 3. Etappe 3 — Bankkontakte-CRUD + TAN-Flow

**Ziel**: Ein User kann einen Bankkontakt anlegen, Credentials setzen,
manuell einen Sync auslösen und die TAN bestätigen. Noch ohne Cron.

**Neue Dateien**:
- `finance/bankcontacts.ts` + `.test.ts`
- `finance/statements.ts` + `.test.ts` (vorerst nur manueller Trigger)
- `finance/tan-sessions.ts` + `.test.ts`
- Frontend: `BankcontactsView`, `BankcontactDetailView`, `TanDialog` +
  `useBankcontactsStore`

**Tests**: Happy-Path TAN-Flow End-to-End mit gemocktem FinTS-Client
(§2.3/§2.4), Session-TTL, Falsche-TAN-Pfad.

**Abhängigkeiten**: Etappe 2.

---

## 4. Etappe 4 — Konten + ACL

**Ziel**: Konten lesbar für berechtigte User; Admin kann Zugriffsrechte
vergeben.

**Neue Dateien**:
- `finance/accounts.ts` + `.test.ts`
- `finance/account-access.ts` + `.test.ts`
- Frontend: `AccountsView`, `AccountDetailView`,
  `AccountAssignmentView` + `useAccountsStore`

**Tests**: ACL-Filter in GET-Endpoints (§2.5), Diff-Speichern im
`account-access` (§2.9).

**Abhängigkeiten**: Etappe 3 (Bankkontakte liefern die FK für Konten).

---

## 5. Etappe 5 — Transaktionen + KI-Tagging

**Ziel**: Transaktionen werden beim Sync persistiert, KI-Vorschläge
entstehen beim Insert, User kann sie annehmen/verwerfen/manuell
ergänzen.

**Neue Dateien**:
- `finance/transactions.ts` + `.test.ts`
- `finance/tags.ts` + `.test.ts`
- `finance/tag-suggester.ts` + `.test.ts`
- `finance/llm-client.ts`
- Embedding-Tabelle als Migration `0044_finance_embeddings.sql`
  (siehe `finance-tagging-and-ai.md` §3.2)
- Frontend: `TransactionsView`, `TransactionDetailView`,
  `TransactionNewView`, `BatchTagView` + `useTransactionsStore`,
  `useTagsStore`

**Tests**: Tag-Promotion, Confidence-Schwelle, Dedupe-Unique-Konflikt
(§2.5/§2.6).

**Abhängigkeiten**: Etappe 4 (Konten vorhanden), `llm-service` läuft.

---

## 6. Etappe 6 — Sync-Cron + Push

**Ziel**: Bankkontakte werden automatisch nach konfigurierten
Zeit-Slots synchronisiert; bei TAN-Bedarf Push.

**Neue Dateien**:
- `finance/statements-cron.ts` + `.test.ts`
- `finance/sync-schedule.ts` (CRUD für `finance_bankcontact.sync_times`)
- Frontend: `SyncScheduleView` + `useSyncScheduleStore`

**Tests**: Slot-Filter mit Fake-Timer, DST-Korrektheit, Cleanup-Cron
(§2.10).

**Abhängigkeiten**: Etappen 3+5 (Statements- und Transactions-Pfad
live), `push.service` verfügbar (bestehend).

---

## 7. Etappe 7 — Datenimport

**Ziel**: Admin kann den Finanzkraft-Export als JSON hochladen; Import
läuft idempotent, ACL wird nachgelagert manuell gesetzt.

**Neue Dateien**:
- `finance/data-import.ts` + `.test.ts`
- `finance/import-schema.ts` (Zod-Schema)
- `finance/fixtures/finanzkraft-export.fixture.ts`
- Frontend: `AdminImportView`

**Tests**: Happy-Path, Re-Import-Idempotenz, Validierungsfehler pro
Stage (§2.8).

**Abhängigkeiten**: Etappen 3–5 (alle Ziel-Tabellen müssen Endpoints
mit Schreib-Logik haben, damit der Import denselben Validierungspfad
nutzen kann).

---

## 8. Etappe 8 — Frontend-Gesamtbild

**Ziel**: Navigationseintrag, Permissions-Guards, Dashboard-Kachel,
globales Layout für alle Finance-Routen.

**Neue Dateien**:
- Route-Registrierung in `frontend/src/router.ts`
- Menü-Eintrag in der Hauptnavigation (hinter `module.finance`)
- Optional: Finance-Dashboard-Widget mit nächster Sync-Zeit und
  TAN-Badge-Counter

**Tests**: manueller Smoke-Test im Browser (kein Component-Test-Setup
im Repo).

**Abhängigkeiten**: Etappen 3–7 (alle Views haben ihre Backends).

**MVP-Abschluss nach dieser Etappe.**

---

## 9. Etappe 9 — Analyse-Abfragen (post-MVP)

**Ziel**: `AnalysisView` nutzbar; Natural-Language-Fragen werden in
Tag-Filter-ASTs übersetzt und aggregiert.

**Neue Dateien**:
- `finance/analysis.ts` + `.test.ts` (Parser + Aggregator)
- Frontend: `AnalysisView` + Store-Erweiterung

**Tests**: Parser gegen Beispiele, SQL-Aggregation mit Fixture-
Transaktionen (§2.7).

**Abhängigkeiten**: MVP (Etappen 1–8).

---

## 10. Parallelisierbarkeit und Teamgröße

Bei einer einzelnen Person: strikt sequentiell, wie oben.

Bei zwei parallelen Streams:
- Stream A (Backend): 1 → 2 → 3 → 4 → 5 → 6 → 7
- Stream B (Frontend): wartet auf Etappe 3, dann parallel zu 4+5+6+7:
  Bankkontakt-/Konto-/Transaktions-/Schedule-Views.
- Stream B kann ab Etappe 5 die UI gegen ein Mock-Backend bauen, wenn
  Stream A hinterherhängt.

---

## 11. Referenzen

| Stelle | Wofür |
|---|---|
| `finance-data-model.md` | Etappen 1, 4, 5 (DB + ACL) |
| `finance-fints-integration.md` | Etappen 2, 3, 6, 10 |
| `finance-tagging-and-ai.md` | Etappen 5, 9 |
| `finance-data-import.md` | Etappe 7 |
| `finance-frontend.md` | Etappen 3–9 (UI-Arbeiten) |
| `finance-service-layout.md` | jede Etappe (Zieldateien) |
| `finance-testing.md` | jede Etappe (Test-Schwerpunkte) |
