# Handover: Finanzen-Modul für fk-encore

Dieses Dokument ist der Starttext für eine neue Claude-Code-Session, die das
Finanzen-Modul in fk-encore umsetzt. Alle Architektur-Entscheidungen und
Vorrecherchen sind hier zusammengefasst, damit die nächste Session ohne
Kontextverlust weiterarbeiten kann.

---

## Aufgabe

Ein neues Modul **„Finanzen"** in `fk-encore` realisieren – als eigenen
Encore.ts-Service `finance/` analog zu `documents/` und `photo/`. Es soll
Bankkonten anbinden, Transaktionen abrufen, kategorisieren und in einer
Vue-3-UI darstellen. Vorlage ist das bestehende Projekt **Finanzkraft**.

## Aktuelles Repo & Branch

- Working dir: `/home/user/fk-encore`
- Branch: `claude/evaluate-yaxi-banking-0kw38` (alle Änderungen hier)
- Stack: Encore.ts + Drizzle + PostgreSQL (Backend), Vue 3.5 + PrimeVue 4.5 +
  Pinia 3 + Vite (Frontend)
- Vorhandene Services als Vorbild: `documents/`, `photo/`, `user/`, `role/`,
  `push/`, `realtime/`
- RBAC: Permissions-Tabelle mit String-Keys (z. B. `roles.read`,
  `photos.purge`), via `requirePermission(authData, "key")` aus
  `user/auth-handler`
- Migrations-Verzeichnis: `db/migrations/postgres/` (zuletzt
  `0041_drop_photo_likes.sql`) → neue Migration startet bei `0042_…`
- Plan-Doku-Konvention: ausführliche Markdown-Dateien unter `docs/` (siehe
  `docs/tax-document-detection.md`, `docs/document-folders.md`)

## Quelle: Finanzkraft (nur als Referenz, NICHT 1:1 portieren)

Drei öffentliche Repos auf GitHub:

| Repo                          | Inhalt                                                                | Stand              |
|-------------------------------|-----------------------------------------------------------------------|--------------------|
| `as19git67/finanzkraft`       | Express-5-Server + Docker-Image, **aktive** Codebase (v1.0.194)       | gepusht 2026-01-22 |
| `as19git67/finanzkraftui`     | Vue 3 + PrimeVue + Pinia (gleicher Stack wie fk-encore!)              | gepusht 2026-01-04 |
| `as19git67/finanzkraftserver` | **veraltet** ("old" laut README), ignorieren                          | letzter Push 2024  |
| `as19git67/lib-fints`         | Eigener Fork von `robocode13/lib-fints`, hier landen Bug-Fixes        | gepusht 2026-01-22 |

**Wichtig**: Code-Qualität von Finanzkraft ist nicht überall sauber →
**Greenfield neu schreiben**, Finanzkraft nur als Referenz für Domänen-Modell,
FinTS-Wrapper-Logik und UI-Komponenten verwenden. Nicht copy-paste.

Lokales Klonen für Lesezugriff:

```bash
mkdir -p /tmp/fk-research && cd /tmp/fk-research
git clone --depth=1 https://github.com/as19git67/finanzkraft.git
git clone --depth=1 https://github.com/as19git67/finanzkraftui.git
git clone --depth=1 https://github.com/as19git67/lib-fints.git
```

## Architektur-Entscheidungen (bereits getroffen)

1. **FinTS direkt** statt PSD2-Aggregator (yaxi etc.). Begründung: passt zu
   fk-encores Self-Hosting-Philosophie, kostenfrei, kein Webhook-Ingress nötig,
   native TypeScript.
2. **`lib-fints` über eigenen Fork** `as19git67/lib-fints` einbinden
   (`"lib-fints": "github:as19git67/lib-fints"` in `package.json`), nicht die
   npm-Version. Im Fork landen bank-spezifische Fixes.
3. **User & Rollen verwaltet weiterhin fk-encore** – Finanzkraft-eigenes
   User-/Role-Modell wird NICHT übernommen.
4. **Berechtigungsmodell hybrid**:
   - **Modul-Permissions** im bestehenden RBAC: `finance.access` (Modul
     nutzen), `finance.accounts.manage` (CRUD Konten/Bankkontakte),
     `finance.rules.manage` (Regelwerk pflegen), `finance.admin` (alle Konten
     sehen, ACL bypassen)
   - **Konto-spezifische ACL** als eigene Tabelle
     `finance_account_access(account_id, user_id, level ENUM('read','write'))`
     – ersetzt Finanzkrafts `Fk_AccountReader`/`Fk_AccountWriter`. Skaliert
     besser als dynamisch generierte Permission-Strings.
5. **ING-Transaktions-Download-Problem**: aktuell defekt in Finanzkraft, soll
   **in fk-encore** (nicht im lib-fints-Fork) gelöst werden.
6. **Datenmigration nötig** aus laufender Finanzkraft-Instanz – Backup liegt
   als JSON vor (Format: Finanzkrafts `dataExport.js` /
   `dataExportAsMoney.js`).

## Banken-Status (mit `lib-fints` produktiv getestet)

Funktionieren: **DKB, Raiffeisenbank, comdirect, comdirect Kreditkarte, MLP
Bank, ING** (ING aktuell mit Transaktions-Download-Problem).

## Wichtigste Code-Bausteine, die in Finanzkraft zu studieren sind

| Datei                                   | Zweck                                                                                                                              | Größe    |
|-----------------------------------------|------------------------------------------------------------------------------------------------------------------------------------|----------|
| `finanzkraft/fints.js`                  | Singleton-Wrapper um `lib-fints`, Status-Modell, `dialogForSync` mit Retry, TAN-Methoden-Auswahl, Wrong-PIN-Erkennung (Code 9910)  | 522 Z.   |
| `finanzkraft/fints.md`                  | Mermaid-Doku des Sync-Flows                                                                                                        | –        |
| `finanzkraft/dbMixinOnlineBanking.js`   | RSA-Keypair + PBKDF2 zur Verschlüsselung der FinTS-Credentials in der DB                                                           | 176 Z.   |
| `finanzkraft/dbMixinTransactions.js`    | Duplikaterkennung (`transactionExists` mit ValueDate ±5/+2, Amount, Text, Referenzfelder), Filter/Suche, Auto-Kategorisierung     | 1012 Z.  |
| `finanzkraft/dbMixinRules.js`           | Regelwerk (RuleSet/RuleAccount/RuleText)                                                                                           | 205 Z.   |
| `finanzkraft/dbSchema.js`               | Komplettes Schema (~20 Fk_-Tabellen)                                                                                               | 1300 Z.  |
| `finanzkraft/as-express.js`             | Cron-Jobs: Statements 06:25 + 15:25 Europe/Berlin, Backup 05:00                                                                    | –        |
| `finanzkraftui/src/stores/onlinebanking.js` | TAN-Zweistufen-Flow im Frontend                                                                                                | 130+ Z.  |
| `finanzkraftui/src/views/BankcontactView.vue` etc. | 22 Vue-Views (Vorbild für UI)                                                                                            | –        |

## Domänen-Modell (Drizzle-Schema, neu in `db/schema.ts` ergänzen)

Tabellen-Präfix `finance_` (statt Finanzkrafts `Fk_`), snake_case statt
camelCase:

- `finance_currency` (id `char(3)`, name, symbol; Seed: EUR, USD)
- `finance_timespan` (Presets: „diesen Monat", „Q1", „vergangene 12 Monate" …)
- `finance_account_type` (id, name, order; Seed: cash, checking, credit, daily,
  savings, security, other)
- `finance_bankcontact` (id, name, fints_url, fints_bank_id,
  fints_user_id_encrypted, fints_password_encrypted)
- `finance_account` (id, name, iban, number, currency_id, account_type_id,
  start_balance numeric(12,2), closed_at, bankcontact_id, fints_account_number,
  fints_error, fints_auth_required bool, fints_activated bool)
- `finance_account_access` (account_id, user_id, level enum read/write) —
  ersetzt Reader/Writer
- `finance_category` (id, name, full_name, parent_id self-ref) — hierarchisch
- `finance_rule_set` (id, name, set_note, set_category_id, is_amount_min/max
  numeric, is_mref)
- `finance_rule_account` (rule_set_id, account_id) — m:n
- `finance_rule_text` (rule_set_id, text)
- `finance_transaction` (id, account_id, booking_date, value_date, amount
  numeric(12,2), text, eref, cred, mref, abwa, abwe, iban, bic, ref, notes,
  payee, payee_payer_acct_no, payee_bank_id, category_id, old_category,
  entry_text, gv_code char(4), prima_nota_no int, original_currency char(3),
  original_amount numeric(12,2), exchange_rate float, rule_set_id, processed
  bool)
- `finance_transaction_status` (transaction_id, user_id, processed bool) —
  pro-User „abgehakt"
- `finance_tag` (id, name unique)
- `finance_tag_transaction` (transaction_id, tag_id)
- `finance_account_balance` (id, account_id, balance numeric, recorded_at)
- **NEU vs. Finanzkraft**: `finance_tan_session` (tan_reference PK, user_id,
  bankcontact_id, banking_information jsonb (serialisierter
  `lib-fints`-State), challenge text, expires_at) — für stateful TAN-Flow
  zwischen zwei HTTP-Requests
- **NEU**: `finance_system_pref` (key, value) — für RSA-Keys (oder direkt
  Encore-Secrets evaluieren)

Indizes nicht vergessen (Finanzkrafts `dbSchema.js` listet alle).

## Encore-Service-Skizze

```
finance/
├── encore.service.ts          → registriert Service, startet Cron-Worker
├── fints-client.ts            → Port von fints.js (Klasse FinTS, Status-Enum)
├── encryption.ts              → RSA + PBKDF2 für Credentials
├── bankcontacts.ts            → CRUD-API (POST/GET/PATCH/DELETE /finance/bankcontacts)
├── accounts.ts                → CRUD-API + ACL-Checks
├── account-access.ts          → CRUD für finance_account_access
├── transactions.ts            → Listen/Suche/manuelle Anlage, Duplikatserkennung
├── statements.ts              → "Sync now" Endpoint + Cron-Trigger
├── tan-sessions.ts            → Stateful TAN-Flow (issue + complete)
├── rules.ts                   → CRUD Regelwerk + Auto-Kategorisierung
├── categories.ts              → CRUD hierarchische Kategorien
├── tags.ts                    → CRUD Tags
├── statements-cron.ts         → CronJob "25 6,15 * * *" Europe/Berlin
├── data-import.ts             → JSON-Backup-Import (einmalig)
└── *.test.ts                  → Vitest pro Modul
```

## Stateful TAN-Flow (kritischer Punkt)

Finanzkraft hat den FinTS-State im Singleton-RAM gehalten – fragil. In
Encore.ts sauber lösen:

1. Client → `POST /finance/bankcontacts/:id/sync`
2. `fints-client.dialogForSync()` läuft. Bei `statusRequiresTAN`:
   - Serialisiere `bankingInformation` aus `lib-fints` als JSON
   - Persistiere in `finance_tan_session(tan_reference uuid, user_id,
     bankcontact_id, banking_information jsonb, challenge, expires_at =
     now()+10min)`
   - Antworte `{ status: "tan_required", tanReference, challenge }`
3. UI zeigt TAN-Dialog
4. Client → `POST /finance/tan-sessions/:tanReference/complete` mit `{ tan }`
5. Lade Session aus DB, rekonstruiere `FinTSConfig` mit `bankingInformation`,
   `client.synchronizeWithTan(...)` rufen, fortsetzen.

## Cron + Push bei TAN-Bedarf

- Encore `CronJob` mit `schedule: "25 6,15 * * *"` (oder zwei mit
  `every: "9h"`-Variante – muss 24 h teilen!) für Statements-Download
- Banken mit `fints_auth_required = false` laufen automatisch durch
- Banken mit TAN-Pflicht: Cron erstellt TAN-Session, schickt Push über
  `push/`-Service an verantwortlichen User

## ING-Problem

Dokumentiere, was beim Transaktions-Download mit ING in Finanzkraft schiefgeht
(Logs/Stacktrace aus laufender Instanz beschaffen), reproduziere im
Encore-Test, fixe in `finance/fints-client.ts` (oder im Fork, wenn
root-cause in `lib-fints`).

## Datenmigration aus JSON-Backup

Finanzkrafts `dataExport.js`/`dataExportAsMoney.js` produziert JSON. In
`finance/data-import.ts` einen Encore-API-Endpoint (`POST /finance/admin/import`
mit `finance.admin`-Permission) bauen, der:

1. JSON parst
2. Kategorien (parent-zuerst), Bankkontakte, Konten, Transaktionen, Tags,
   Regeln in die neuen Tabellen schreibt
3. User-IDs auf fk-encore-User mappt (Mapping-Tabelle als Input-Parameter)
4. ACL-Einträge aus Finanzkrafts `Fk_AccountReader`/`Fk_AccountWriter`
   rekonstruiert

## Frontend-Portierung

Stack-Match ist 100% (Vue 3.5, PrimeVue 4.5, Pinia 3). Pro Etappe:

- Komponenten **inhaltlich** übernehmen (Layout/Felder/Validierungen aus
  Finanzkraft-Views), aber **Code neu schreiben** – axios-Calls auf
  fk-encore-API-Helper umstellen, Auth via fk-encore-User-Store
- Views: `BankcontactsView`, `BankcontactView`, `AccountsView`, `AccountView`,
  `TransactionListView`, `TransactionDetailView`, `TransactionNewView`,
  `RuleSetsView`, `RuleSetEditView`, `CategorySelectionView`,
  `BatchSetCategoryView`, `BatchSetTagsView`, `TransactionRulesView`
- Stores: `accounts`, `transactions`, `onlinebanking`, `masterdata`
  (Currencies/AccountTypes/Categories/Timespans/Tags), `preferences`

## Etappen-Roadmap (in dieser Reihenfolge)

| #  | Inhalt                                                                                                                                                               | Liefergegenstand      |
|----|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------|
| 0  | Plan-Dokument schreiben (`docs/finance-module.md` im Stil von `docs/tax-document-detection.md`), commit                                                              | Doku-PR               |
| 1  | DB-Schema (alle `finance_*`-Tabellen), Migration `0042_finance_initial.sql`, Drizzle-Typen, Seeds (Currency/AccountType/Timespan), Modul-Permissions                 | grüne Tests           |
| 2  | `finance/encryption.ts` + `finance/fints-client.ts` + Unit-Tests (Mock `lib-fints`)                                                                                  | grüne Tests           |
| 3  | Bankcontact-API + Account-API + ACL-API + Tests                                                                                                                      | grüne Tests           |
| 4  | TAN-Session + `statements.ts` (Sync-Endpoint, manueller Trigger) + Tests                                                                                             | grüne Tests           |
| 5  | Transaktions-Persistenz inkl. Duplikaterkennung + Listen/Filter/Suche-API                                                                                            | grüne Tests           |
| 6  | Categories + Tags + Rules + Auto-Kategorisierung beim Insert                                                                                                         | grüne Tests           |
| 7  | Cron + Push bei TAN-Bedarf                                                                                                                                           | manuell prüfbar       |
| 8  | Datenmigrations-Script `finance/data-import.ts` + Trockenlauf gegen JSON-Backup                                                                                      | Migrations-Bericht    |
| 9  | Frontend-Views + Stores                                                                                                                                              | klickbar              |
| 10 | ING-Problem reproduzieren + fixen                                                                                                                                    | Bug-Doku + Fix        |
| 11 | Optional: `llm-service` als Zweitmeinung für unkategorisierte Transaktionen                                                                                          | grüne Tests           |

## Konventionen aus fk-encore beachten

- Encore.ts API-Pattern: `api({ method, path, expose, auth }, async (req) => { ... })`
- Auth: `requirePermission(getAuthData()!, "key")` am Anfang jedes Handlers
- Drizzle-Imports: `import { db } from "../db/database"` o. ä. (siehe
  `documents/documents.ts`)
- Tests: Vitest, `encore test`, isolierte DB pro Test
- Logging: `import log from "encore.dev/log"`
- Secrets: `import { secret } from "encore.dev/config"`, Local-Override in
  `.secrets.local.cue`
- Cron: `import { CronJob } from "encore.dev/cron"`
- Niemals neue Markdown-Dateien außer auf explizite Anforderung

## Aufgabe für die nächste Session

**Starte mit Etappe 0**: Schreibe `docs/finance-module.md` (Stil wie
`docs/tax-document-detection.md`/`docs/document-folders.md`, deutsch,
strukturiert). Inhalt: alle Architektur-Entscheidungen oben, vollständiges
Drizzle-Schema-Skizze, TAN-Session-Sequenzdiagramm (Mermaid),
Etappen-Roadmap, offene Punkte. Danach commit auf
`claude/evaluate-yaxi-banking-0kw38` und pushe.

Frage nach, wenn etwas unklar ist, bevor große Code-Strecken entstehen.
