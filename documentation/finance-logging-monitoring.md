# Finance — Logging & Monitoring

Ziel: Festlegen, was im Finanz-Modul geloggt wird, wie der User
Fehlzustände sichtbar bekommt (UI + Push) und wie der Admin sie im
laufenden Betrieb findet.

Status: Feature-Plan, Umsetzung parallel zur jeweiligen Etappe aus
`finance-roadmap.md`.

---

## 1. Ausgangslage im Repo

- **Vorherrschendes Muster**: `console.log` / `console.error` mit
  Präfix in eckigen Klammern (`[boot] …`, `[documents] …`) — siehe
  `documents/encore.service.ts` und `documents/inbox-cron.ts`.
- **Strukturiertes Logging** via `encore.dev/log` existiert, wird aber
  nur in `backup/` und `realtime/` verwendet.
- **Keine** Prometheus-Metriken, kein Sentry, kein APM. Monitoring läuft
  über Logs + DB-Spalten, die die UI anzeigt.

Entscheidung für Finance: **dasselbe Muster wie `documents/`** —
`console.log`/`console.error` mit Präfix `[finance] …` oder
`[finance.<submodul>] …`. Strukturiertes Logging ist ein Nice-to-have,
kein MVP-Muss.

---

## 2. Log-Events pro Modul

### 2.1 Sync-Cron (`statements-cron.ts`)

Pro Tick **eine Info-Zeile**, nicht pro Bankkontakt — sonst wird das
Log bei vielen Kontakten unlesbar.

```
[finance.cron] sync tick: contacts=5 dueForSlot=2
[finance.cron] sync done: ok=2 tanRequired=0 errored=0 (duration=1842ms)
```

Pro Bankkontakt **nur bei Änderung** (TAN-Bedarf oder Fehler):

```
[finance.cron] bankcontact=3 (Sparkasse XY) → tan-required, push sent
[finance.cron] bankcontact=7 (ING) → error: 9910 wrong-pin
```

Ergebnis persistiert zusätzlich in `finance_bankcontact.last_sync_at`
und `finance_bankcontact.last_sync_status` (String-Enum: `ok`,
`tan-required`, `error:<code>`). Das ist die Quelle für die UI-Badge
in `BankcontactsView` (siehe `finance-frontend.md` §4.5).

### 2.2 TAN-Flow (`statements.ts`, `tan-sessions.ts`)

```
[finance.tan] session created: ref=<uuid> bankcontact=3 user=42 expires=2026-04-23T15:35:00Z
[finance.tan] session completed: ref=<uuid> imported=17 balances=1
[finance.tan] session failed: ref=<uuid> reason=wrong-tan attempt=2/3
[finance.tan] session expired (deleted by cleanup): ref=<uuid>
```

UUIDs werden voll geloggt — sie sind Einmal-Werte und enthalten keine
Geheimnisse. Weder TAN-Wert noch `banking_information`-Payload landen
im Log.

### 2.3 Credential-Crypto (`encryption.ts`)

Nur **Fehler** loggen — ein erfolgreicher Roundtrip ist Rauschen.

```
[finance.crypto] decrypt failed for bankcontact=3: auth-tag mismatch
```

Wichtig: Weder Key noch Blob jemals loggen. Tests stellen das sicher
(spy auf `console.error`).

### 2.4 KI-Pipeline (`tag-suggester.ts`, `llm-client.ts`)

```
[finance.ai] suggest tags: tx=421876 neighbors=20 suggested=3 accepted=2
[finance.ai] llm-service unavailable: retries-exhausted, skipping tx=421876
```

Fehler blockieren den Insert nicht — der Vorschlag fehlt einfach.
`LlmServiceUnavailableError` (aus dem bestehenden Pattern) wird
abgefangen und als Warnung geloggt.

### 2.5 Datenimport (`data-import.ts`)

Stage-weise, damit man den Fortschritt im Log sieht:

```
[finance.import] job=<uuid> start: user=1 file=finanzkraft-2026-04.json size=2.4MB
[finance.import] job=<uuid> stage=bankcontacts: inserted=5 skipped=0 errors=0
[finance.import] job=<uuid> stage=accounts: inserted=12 skipped=0 errors=0
[finance.import] job=<uuid> stage=transactions: inserted=48710 skipped=2 errors=0
[finance.import] job=<uuid> done: duration=187s validationErrors=2
```

### 2.6 Analyse (`analysis.ts`)

Nur **Frage-Hash + AST-Shape**, nie die Rohfrage (kann persönliche
Infos enthalten wie Krankheitsnamen).

```
[finance.analysis] parsed: hash=<sha256-8> tags=2 op=AND timespan=92d
```

---

## 3. Sichtbarkeit für den User

### 3.1 UI-Anzeigen

| Wo | Quelle | Bedeutung |
|---|---|---|
| `BankcontactsView` Status-Spalte | `last_sync_status` | ✓ OK / ⚠ TAN / ⛔ Fehler (gelbe/rote Zeile) |
| `BankcontactDetailView` Sync-Box | `last_sync_status` + `last_sync_at` | „Letzter Sync: 2026-04-23 06:25 — OK, 3 Umsätze" oder Fehlermeldung |
| Haupt-Navigation | Count offener `finance_tan_session` des Users | Badge am Menüpunkt „Finance" |
| `AdminImportView` | SSE/Polling auf `/finance/admin/import/:jobId/status` | Live-Fortschritt je Stage |

### 3.2 Push-Benachrichtigungen

Gesendet über `push.service.notifyUser(userId, ...)`. Der User ist der
Owner des Bankkontakts (ermittelt aus `finance_account_access.level =
'write'`; fällt auf den ersten Write-User zurück, wenn es mehrere gibt):

| Ereignis | Titel | Body |
|---|---|---|
| Sync-Cron meldet `tan-required` | „TAN erforderlich — {Bank}" | „Bitte im Browser bestätigen." |
| N-ter Fehl-Sync in Folge (N=3) | „Sync fehlgeschlagen — {Bank}" | „Letzter Fehler: {Code}. Bitte Credentials prüfen." |

**Rate-Limit**: TAN-Push pro Bankkontakt maximal einmal alle 30 min,
Fehl-Sync-Push einmal alle 6 h — sonst nervt der Cron den User. Siehe
`finance-rate-limiting.md` (folgt als nächste Doku) für Details.

---

## 4. Sichtbarkeit für den Admin

### 4.1 Log-Grep-Rezepte

```bash
# Alle Cron-Ticks der letzten Stunde
grep '\[finance.cron\]' logs/encore.log | tail -60

# Fehl-Syncs gezählt pro Bankkontakt
grep '\[finance.cron\].*→ error' logs/encore.log \
  | awk '{print $3}' | sort | uniq -c

# Laufende Import-Jobs
grep '\[finance.import\]' logs/encore.log | grep -v 'done:'

# TAN-Sessions, die in den letzten 24 h abgelaufen sind
grep '\[finance.tan\] session expired' logs/encore.log
```

### 4.2 DB-Health-Queries

```sql
-- Bankkontakte, die seit > 24 h nicht erfolgreich syncen
SELECT id, name, last_sync_at, last_sync_status
FROM finance_bankcontact
WHERE last_sync_status <> 'ok'
   OR last_sync_at < now() - interval '24 hours';

-- Zahl der TAN-Sessions (Indikator für UI-Klemmer)
SELECT count(*) FROM finance_tan_session
WHERE expires_at > now();

-- KI-Vorschläge, die länger als 30 Tage unbearbeitet liegen
SELECT count(*) FROM finance_tag_transaction tt
JOIN finance_tag t ON t.id = tt.tag_id
WHERE t.source = 'ai' AND tt.created_at < now() - interval '30 days';
```

Diese Queries können später optional als kleiner Admin-Dashboard-View
(`FinanceHealthView`) gebündelt werden — nicht MVP, aber billig.

---

## 5. Was wir bewusst nicht machen

- **Keine externe Telemetrie** (Sentry, Datadog) — das Projekt ist
  self-hosted, Logs reichen.
- **Kein Structured-Logging-Zwang** — `encore.dev/log` darf genutzt
  werden, ist aber nicht Pflicht. Wichtig ist ausschließlich das
  Präfix-Muster, damit `grep` konsistent funktioniert.
- **Keine Alerting-Pipeline** — der User wird über Push informiert,
  der Admin findet Probleme über die DB-Spalte `last_sync_status`
  oder per Log-Grep. Ein dedizierter Alerting-Kanal (Slack/E-Mail)
  kann später als separate Etappe kommen.
- **Keine Log-Redaktion als Framework** — stattdessen Disziplin in den
  Tests: jede neue Datei bekommt einen Test, der prüft, dass bestimmte
  Felder (`credentials_encrypted`, TAN-Wert, `banking_information`)
  niemals in `console.error`/`console.log`-Aufrufen landen.

---

## 6. Offene Punkte

- **Log-Rotation**: wer schneidet `logs/encore.log` ab? Aktuell
  anscheinend nicht reglementiert. Finance wird das Volumen nicht
  drastisch erhöhen, aber bei dem geplanten Push-Rauschen (TAN-Events)
  sollte der Admin das einmal prüfen.
- **`encore.dev/log` als Pflicht** für neue Module — Team-Entscheidung
  ausstehend. Pragmatisch reicht `console.*` für jetzt.
- **Retention für KI-Vorschläge**: sollen unbearbeitete `source='ai'`-
  Joins nach 90 Tagen automatisch gelöscht werden? DB-Query dafür ist
  in §4.2 bereits skizziert.
- **Admin-Dashboard**: eigener View oder in `BankcontactsView` als
  „Alles anzeigen"-Toggle für `finance.admin`?
