# Finance — Test-Strategie

Ziel: Festlegen, was in welchem Modul des Finanz-Services getestet wird,
welches Mocking-Muster für externe Abhängigkeiten gilt und wie die Tests
in das vorhandene Vitest-Setup von fk-encore eingebunden werden.

Status: Feature-Plan, Umsetzung pro Etappe parallel zur jeweiligen
Implementierung.

---

## 1. Tooling und Konventionen

Bestand (siehe `vitest.config.ts`):

- **Vitest** als Runner; Tests collocated als `*.test.ts`.
- **Postgres-Test-DB** `encore_test` (Connection-String aus
  `POSTGRES_TEST_CONNECTION_STRING`). Keine Mocks für DB-Operationen.
- **`fileParallelism: false`** — Tests laufen sequentiell; jede Testdatei
  darf das Schema beliebig manipulieren.
- **`globalSetup`** und **`setupFiles`** liefern Migrationen +
  Basis-Seeds; jede Testdatei räumt selbst per `DELETE FROM …` in
  `beforeEach` auf, was sie braucht.
- **Encore-Endpoints werden als Funktionen gerufen**, nicht über HTTP
  (siehe Encore-Doku „Test an API endpoint" — direkter Funktionsaufruf
  liefert dieselbe Type-Safety wie der generierte Client).

Konvention für die neuen Tests im Finanz-Modul: dieselbe Struktur wie
`documents/documents.test.ts` und `user/auth-handler.test.ts`.

---

## 2. Test-Matrix pro Modul

Übersicht, was pro Datei aus `finance-service-layout.md` §1 mindestens
abgedeckt sein muss.

### 2.1 `encryption.test.ts`

- Roundtrip: `decrypt(encrypt(x)) === x` für ASCII, UTF-8 (Umlaute,
  Emojis), leeren String.
- Tampering: ein gefälschter Auth-Tag → Exception (`AES-GCM`-Fehler),
  kein stilles Ergebnis.
- Falscher Key (anderes Secret) → Exception.
- Format-Stabilität: zwei `encrypt`-Aufrufe mit gleichem Plaintext
  liefern unterschiedliche Ciphertext-Blobs (IV-Randomness).
- Rotations-Skript-Vorbereitung: getrennte `encryptWithKey(key, x)` /
  `decryptWithKey(key, blob)`-Helper ermöglichen Re-Encrypt-Tests
  ohne Process-Restart.

### 2.2 `fints-client.test.ts`

`lib-fints` selbst wird **nicht** im Unit-Test angesprochen — wir mocken
das Default-Export als Vitest-Modul-Mock und prüfen unseren Wrapper.

- Mapping FinTS-Code 9910 → `state: "error"`, `errorCode: "9910"`.
- Mapping `tan-required` aus lib-fints-Response → `state:
  "tan-required"` mit gefülltem `tanChallenge` und
  `bankingInformation`.
- Resume-Pfad: Wrapper ruft `lib-fints` mit der `bankingInformation`
  aus dem Aufruf, nicht mit frischem Init-State.
- Retry-Verhalten: Netzwerkfehler löst maximal 2 Retries aus (mit
  `vi.useFakeTimers()` für die Backoff-Pausen).

Integrations-Test gegen echte Bank-Server: **nicht** in der
Test-Pipeline; manuell vor Release gegen Testzugänge.

### 2.3 `tan-sessions.test.ts`

- TTL-Verhalten: `complete` mit Reference, deren `expires_at < now()`,
  liefert `410 Gone`; Datensatz bleibt aber unverändert (Cleanup-Cron
  räumt auf, nicht der Endpoint).
- Falsche TAN: `complete` mit gemocktem `fints-client`, der
  `state: "error"` liefert → 401 an den Caller, Session bleibt für
  weitere Versuche aktiv.
- User-Bezug: Caller A darf Reference von Caller B nicht abschließen
  (403); Test mit zwei verschiedenen `getAuthData()`-Mocks.
- Erfolg: bei `state: "idle"` werden sowohl die Transaktionen
  persistiert (Insert in `finance_transaction`) als auch die Session
  gelöscht — beides in einer Transaktion.

### 2.4 `statements.test.ts`

- Sync-Trigger ohne TAN: gemockter `fints-client.dialogForSync`
  liefert `state: "idle"` → Endpoint speichert Transaktionen,
  Antwort `200 { imported: N }`.
- Sync-Trigger mit TAN: gemockter Client liefert `state:
  "tan-required"` → Endpoint persistiert `finance_tan_session`,
  antwortet `409 Conflict` mit `tanReference` + `challenge`.
- Permission-Check: User ohne `finance.accounts.manage` bekommt 403,
  bevor der Client überhaupt gerufen wird.

### 2.5 `transactions.test.ts`

- ACL-Filter in `GET /finance/transactions`: User mit `level='read'`
  auf Konto A sieht ausschließlich Buchungen von Konto A — Test mit
  3 Konten und 2 ACL-Einträgen.
- `level='write'`-Pflicht für manuelle Buchungen: User mit nur
  `read`-ACL → 403 bei `POST /finance/transactions`.
- Tag-Promotion: bestehender AI-Join + neuer User-Join in einer
  Transaktion; Idempotenz, wenn der User-Tag schon existiert.
- Batch-Tag: 50 ausgewählte Transaktionen, „nur hinzufügen" vs.
  „ersetzen" — Anzahl der `finance_tag_transaction`-Zeilen exakt
  prüfen.
- Duplikat-Schutz: zweimaliger Insert mit gleichem `dedupe_hash` →
  zweiter Versuch liefert `Conflict` aus dem Unique-Index, ohne dass
  die DB-Transaktion alles davor zerstört.

### 2.6 `tags.test.ts` & `tag-suggester.test.ts`

- `tag-suggester`: gemockter `llm-client.suggestTags` mit fixer
  Response → korrekte Persistierung als `source='ai'` + `confidence`.
- AI-Vorschlag mit `confidence < 0.3` → wird verworfen (kein Insert).
- AI-Vorschlag, dessen Tag-Name bereits als User-Tag auf derselben
  Transaktion existiert → kein Insert (Doppel-Bestätigung vermeiden).
- `tags.suggest`-Batch-Endpoint: läuft über N Transaktionen, schreibt
  Vorschläge transaktions-isoliert (ein Fehler bricht nur die eine
  Transaktion ab).

### 2.7 `analysis.test.ts`

- Parser-Mock: gemockter `llm-client.parseAnalysisQuery` liefert
  bekannten AST → SQL-Aggregator liefert exakte Summen aus einem
  Test-Fixture mit 10 vorab angelegten Transaktionen.
- AND vs. OR auf Tags: gleicher Fixture, beide Operatoren, exakte
  Erwartungswerte.
- Zeitraum-Filter: `from`/`to` exklusiv vs. inklusiv festnageln und
  testen.

### 2.8 `data-import.test.ts`

- Glücklicher Pfad: kleiner JSON-Fixture (2 Bankkontakte, 3 Konten,
  20 Transaktionen, 5 Tags) → exakte Counts in der Response.
- Re-Import desselben JSON: alle `skipped`-Counts entsprechen den
  ursprünglichen `counts`, keine Duplikate in der DB.
- Validierungsfehler: Transaktion verweist auf unbekanntes Konto →
  Eintrag in `validationErrors`, aber Bankkontakte und Konten sind
  trotzdem persistiert (Stage-Isolation).
- Permission: `finance.view`-User → 403 ohne Side-Effect.

### 2.9 `account-access.test.ts`

- Diff-Speichern: bestehende ACL `[A:read, B:write]`, neue Liste
  `[A:write, C:read]` → genau drei DB-Operationen (Update A, Delete B,
  Insert C), nicht „erst alle weg, dann alle neu".
- Permission: nur `finance.admin`; Test mit `finance.accounts.manage`
  → 403.

### 2.10 `statements-cron.test.ts`

- Slot-Filter: `sync_times = [{weekdays:[1..5], time:"06:25",
  tz:"Europe/Berlin"}]`, `now()` ist Mittwoch 06:26 Berlin → Tick
  feuert; Mittwoch 09:00 → Tick feuert nicht.
- DST: `now()` ist Sommerzeit-Datum, Slot 06:25 Berlin → korrekte
  UTC-Umrechnung (04:25 UTC, nicht 05:25). Test mit explizit
  gesetztem Datum via `vi.setSystemTime`.
- Cleanup-Cron: drei Sessions mit gestaffelten `expires_at`, nur die
  abgelaufenen werden gelöscht.

---

## 3. Mocking-Pattern

| Externe Abhängigkeit | Strategie |
|---|---|
| `lib-fints` | `vi.mock("lib-fints", () => …)` auf Modul-Ebene; im Test pro Beschreibung passende Antwort konfigurieren. |
| `llm-service` (`fetch`) | `vi.spyOn(globalThis, "fetch")` mit JSON-Response; Tests prüfen sowohl Request-Body (Prompt-Inhalt) als auch Verarbeitung der Response. |
| `push.service` | direkter Mock von `notifyUser` aus `push/push.ts`; Tests prüfen, dass die Funktion mit korrektem `userId` und Payload gerufen wurde. |
| Drizzle / Postgres | **nicht mocken** — echte Test-DB nutzen. |
| `getAuthData()` aus `~encore/auth` | Helper `withAuthData(authData, fn)` aus `user/auth-handler.test.ts` wiederverwenden. |
| Zeit (`Date.now`, Timers) | `vi.useFakeTimers()` + `vi.setSystemTime(…)`; immer in `afterEach` zurücksetzen. |

`fints-client.ts` selbst wird in den Endpoint-Tests gemockt, damit
diese Tests reine Endpoint-Logik prüfen — der echte Wrapper hat seine
eigene Suite (§2.2).

---

## 4. Fixtures

Pro Test-Bereich ein kleines, statisches Fixture-Modul, **keine**
Faker-/Random-Daten. Beispielstruktur:

```
finance/
├── fixtures/
│   ├── bankcontacts.fixture.ts
│   ├── accounts.fixture.ts
│   ├── transactions.fixture.ts
│   └── finanzkraft-export.fixture.ts
```

Fixtures sind reine TypeScript-Objekte, die in `beforeEach` per
`db.insert(...).values(fixture).execute()` geladen werden.
`finanzkraft-export.fixture.ts` ist ein bewusst klein gehaltener,
hand-kuratierter JSON-Schnipsel des realen Export-Formats.

---

## 5. Was wir bewusst nicht testen

- **Echter FinTS-Server**: lib-fints-Verhalten gegen produktive Banken
  läuft als manueller Smoke-Test vor Release, nicht in CI.
- **`lib-fints` selbst**: ist Upstream-Verantwortung; Bugs gehen als
  Issue/PR dorthin.
- **`llm-service`-Antwortqualität**: wir testen Prompt-Erstellung und
  Response-Parsing, nicht ob das LLM „gute" Tags vorschlägt — das ist
  Sache der Modell-Evaluation.
- **PrimeVue / Vue-Komponenten**: kein Component-Test im MVP (kein
  bestehendes Vue-Test-Setup im Repo).
- **End-to-End / Browser**: nicht Teil dieser Etappe.

---

## 6. CI-Einbindung

Bestehende Pipeline ruft `npm test` (= Vitest). Die neuen `*.test.ts`-
Dateien werden automatisch eingesammelt — **kein** Eingriff in
`vitest.config.ts` nötig, sofern wir bei `finance/**.test.ts` bleiben
(deckt sich mit `exclude` und Default-Include).

`encore test` läuft zusätzlich, sobald die Migrationen committed sind;
das ist zukünftig der Goldstandard für Endpoint-Tests, weil es die
Encore-Test-DB-Isolation pro Test gewährleistet (siehe Encore-Doku
„Test database setup"). Im MVP genügt der vorhandene `encore_test`-DB-
Ansatz.

---

## 7. Referenzen

| Stelle | Wofür |
|---|---|
| `vitest.config.ts` | Setup, Test-DB, `fileParallelism` |
| `documents/documents.test.ts` | Beispiel-Stil (Imports, `describe`/`it`) |
| `user/auth-handler.test.ts` | `withAuthData`-Helper für Permissions-Tests |
| `finance-service-layout.md` §1 | Liste der zu testenden Dateien |

---

## 8. Offene Punkte

- **Soll `encore test` ab Etappe 1 verpflichtend sein**, oder nutzen wir
  weiter `npm test` direkt (Encore-Test-DB-Isolation kostet pro Test
  Setup-Zeit)?
- **Coverage-Ziel** für das Finanz-Modul: das Repo hat aktuell keine
  Coverage-Schwelle; sollen wir für `finance/**` z. B. 80% Lines
  ansetzen?
- **Property-based Tests** für `encryption.ts` (Roundtrip über zufällige
  Inputs via `fast-check`) — Mehrwert oder Overkill?
