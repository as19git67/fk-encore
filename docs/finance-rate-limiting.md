# Finance — Rate-Limiting & Brute-Force-Schutz

Ziel: Festlegen, welche Finanz-Endpoints geschützt werden müssen, welche
Limits angemessen sind und wie das mit dem bestehenden Rate-Limiter aus
`user/rateLimiter.ts` umgesetzt wird — ohne eigene Infrastruktur.

Status: Feature-Plan, Umsetzung mit den jeweiligen Endpoints aus
`finance-roadmap.md`.

---

## 1. Ausgangslage im Repo

`user/rateLimiter.ts` bietet:

- `getClientIp()` — liest `X-Forwarded-For` bzw. `X-Real-IP` aus dem
  Encore-Request (über `currentRequest()`).
- `checkRateLimit(key)` — Sliding-Window-Zähler (10 Versuche / 15 min),
  wirft `APIError` mit HTTP 429 bei Überschreitung.
- `resetRateLimit(key)` — für erfolgreiche Operationen (Gegenstück).
- Storage: **In-Memory-Map**, pro Prozess. Limitierung ist damit an
  einen Instanz-Prozess gebunden; bei Multi-Instance-Deployment
  irrelevant für die aktuellen Auth-Endpoints (Single-Instance-
  Produktion) — Hinweis im Datei-Kommentar: ggf. auf Encore Cache
  (Redis) migrieren.

Nutzer bisher: `user/auth.service.ts` (Login), `user/passkey.ts`
(Passkey-Attempts). **Kein** anderer Service limitiert aktuell.

Entscheidung für Finance: **bestehenden Rate-Limiter wiederverwenden**,
nicht neu bauen. Keys werden so gewählt, dass die Auth-Limits und
Finanz-Limits unabhängig zählen.

---

## 2. Welche Endpoints werden limitiert

Nur Endpoints mit realem Missbrauchs-/DoS-Risiko werden beschränkt;
reine Lese-Endpoints bleiben unlimitiert (liegen hinter `finance.view`
und der ACL).

| Endpoint | Methode | Limit | Key | Begründung |
|---|---|---|---|---|
| `/finance/tan-sessions/complete` | POST | 5 / 10 min | `tan-complete:<tan_reference>` | FinTS-Server limitiert selbst (i. d. R. 3 TAN-Versuche), aber wir wollen verhindern, dass ein Angreifer die TAN-Referenz von Dritten brute-forced, solange sie nicht abgelaufen ist. Key ist **pro Reference**, nicht pro IP — drei Benutzer hinter NAT dürfen sich nicht gegenseitig aussperren. |
| `/finance/bankcontacts/:id/credentials` | POST | 10 / 15 min | `bank-creds:<userId>:<bankcontactId>` | Credential-Set-Rate eindämmen — verhindert, dass ein kompromittierter User-Account beliebig viele Credential-Änderungen probiert (Rauschen im Log + CPU für Crypto). |
| `/finance/statements` | POST | 20 / 15 min | `sync-trigger:<userId>:<bankcontactId>` | Manueller Sync-Trigger: begrenzt pro User×Bankkontakt, damit niemand versehentlich (oder böswillig) die Bank mit HBCI-Dialogen flutet. Der Cron läuft sowieso eigenständig. |
| `/finance/admin/import` | POST | 3 / 60 min | `finance-import:<userId>` | Import ist teuer (Minuten, große DB-Transaktionen). Drei Versuche pro Stunde sind mehr als der Admin in Wirklichkeit braucht. |
| `/finance/analysis/query` | POST | 30 / 10 min | `analysis-query:<userId>` | LLM-Call beim Parsing kostet Rechenzeit des `llm-service`. Edit-basierte Re-Aggregate (`/finance/analysis/aggregate`) zählen **nicht** mit, weil sie kein LLM rufen. |
| `/finance/tags/suggest` | POST | 5 / 60 min | `tag-suggest-batch:<userId>` | Batch-Endpoint läuft über viele Transaktionen → viele LLM-Calls. Strikt begrenzen. |

Nicht limitiert (aber dokumentieren, warum):

| Endpoint | Grund |
|---|---|
| `GET /finance/accounts`, `/finance/transactions`, `/finance/tags` | Reine Reads, ACL-gefiltert, kein Missbrauchsanreiz. |
| `POST /finance/transactions` (manuelle Buchung) | Schreibt genau eine Zeile; Missbrauch wäre höchstens DB-Rauschen, kein DoS. |
| `POST /finance/transactions/:id/tags/promote` | Billige Operation, nur innerhalb der eigenen ACL. |
| `POST /finance/analysis/aggregate` | Reine SQL-Aggregation, kein LLM-Call. |

---

## 3. Integration im Handler-Code

Dasselbe Muster wie in `user/auth.service.ts`. Beispiel für
`tan-sessions.complete`:

```ts
import { checkRateLimit, resetRateLimit, getClientIp } from
  "../user/rateLimiter";

export const complete = api(
  { expose: true, method: "POST", path: "/finance/tan-sessions/complete" },
  async (req: CompleteReq): Promise<CompleteRes> => {
    const auth = getAuthData()!;
    await requirePermission(auth, "finance.accounts.manage");

    const key = `tan-complete:${req.tanReference}`;
    checkRateLimit(key, { maxAttempts: 5, windowMs: 10 * 60_000 });

    const result = await finishTanDialog(req.tanReference, req.tan);
    if (result.state === "idle") {
      resetRateLimit(key);      // Erfolg: Zähler zurücksetzen
    }
    return { imported: result.imported ?? 0 };
  },
);
```

Der bestehende `checkRateLimit(ip)` aus `user/rateLimiter.ts` bekommt in
dieser Etappe einen zweiten Parameter `{ maxAttempts, windowMs }`,
damit nicht jeder Endpoint die Default-Limits (10 / 15 min) erbt.

### 3.1 Signatur-Erweiterung

Aktuell:
```ts
export function checkRateLimit(ip: string): void
```

Erweiterung (rückwärtskompatibel):
```ts
interface RateLimitOpts {
  maxAttempts?: number;   // default: 10
  windowMs?: number;      // default: 15 * 60 * 1000
}
export function checkRateLimit(key: string, opts?: RateLimitOpts): void
```

Die Umbenennung `ip` → `key` im Parameter macht sichtbar, dass
Finance-Keys keine IPs sind. Der bestehende Caller in
`user/auth.service.ts` übergibt weiterhin `getClientIp()` — Verhalten
identisch.

---

## 4. Frontend-Verhalten bei 429

Die Frontend-Stores fangen HTTP 429 ab und zeigen eine
`PrimeVue.Toast`-Nachricht:

> „Zu viele Versuche — bitte {remainingSeconds}s warten."

Der `Retry-After`-Header wird von `checkRateLimit` gesetzt
(Ergänzung am bestehenden Helper: aktuelle `resetAt - now()`-
Differenz in Sekunden). Die Stores lesen den Header und setzen einen
Countdown-State, den die UI z. B. im `TanDialog` als disabled-Button
mit Timer anzeigt.

---

## 5. Push-Rate-Limiting (Verbindung zu `finance-logging-monitoring.md`)

Die in §3.2 des Logging-Dokuments genannten Push-Rate-Limits (TAN:
max. 1× / 30 min pro Bankkontakt; Fehl-Sync: max. 1× / 6 h) laufen
**nicht** über `checkRateLimit` — das ist kein Endpoint-Schutz,
sondern Notification-Dedupe. Implementierung in `statements-cron.ts`:

```ts
// Einfache DB-gestützte Dedupe-Zeile
CREATE TABLE finance_push_dedupe (
  scope      TEXT NOT NULL,       -- "tan-required" | "sync-failed"
  entity_id  INTEGER NOT NULL,    -- bankcontact_id
  last_sent  TIMESTAMP NOT NULL,
  PRIMARY KEY (scope, entity_id)
);
```

Der Cron prüft vor `notifyUser(...)`:

```ts
const lastSent = await db.queryRow<{ last_sent: string }>`
  SELECT last_sent FROM finance_push_dedupe
  WHERE scope = ${scope} AND entity_id = ${bankcontactId}`;
if (lastSent && Date.now() - Date.parse(lastSent.last_sent) < windowMs) {
  return;  // still cooling down
}
// send + upsert last_sent
```

Die Tabelle gehört in eine Folge-Migration (z. B. `0045_finance_push_dedupe.sql`)
und ist nicht Teil der Initial-Migration aus Etappe 1.

---

## 6. Was wir bewusst nicht machen

- **Kein IP-basiertes Limiting auf Finanz-Endpoints** — User sitzen oft
  hinter NAT, und die Endpoints sind alle `auth: true` (kein
  IP-Brute-Force ohne gültiges Session-Cookie denkbar). Limits laufen
  pro User oder pro Ressource.
- **Kein Captcha / reCAPTCHA** — der Auth-Layer schützt den Einstieg
  bereits, und Finanz-Endpoints sind nie öffentlich.
- **Keine Redis-Migration im MVP** — das Projekt läuft als Single-
  Instance. Wenn das später skaliert werden muss, ist der Rate-Limiter
  laut Kommentar in `user/rateLimiter.ts` ohnehin der erste Kandidat
  für Encore-Cache (Redis).
- **Keine per-Route-Config-Datei** — Limits stehen im jeweiligen
  Handler als Literal neben dem Aufruf; das hält die Konfiguration lokal
  zu ihrem Kontext.

---

## 7. Tests (Ergänzung zu `finance-testing.md`)

Pro limitiertem Endpoint mindestens drei Tests:

1. **Normale Nutzung**: 3 Aufrufe innerhalb des Windows → alle
   erfolgreich.
2. **Überschreitung**: `maxAttempts + 1` schnelle Aufrufe → der letzte
   wirft `APIError` 429.
3. **Reset nach Erfolg**: Aufruf, der `resetRateLimit(key)` triggert,
   setzt den Zähler auf 0 — danach wieder `maxAttempts` Versuche frei.

Vitest-Setup: `vi.useFakeTimers()`, damit das Window ohne `sleep`
simuliert werden kann. Die In-Memory-Map wird pro Test in
`beforeEach` über einen neu zu erstellenden Helper
`__resetRateLimiterForTests()` geleert (Export aus
`user/rateLimiter.ts`, nur in Tests verwendet).

---

## 8. Offene Punkte

- **Limit-Tuning**: die Zahlen in §2 sind Schätzungen; nach drei Monaten
  Produktivbetrieb gegen Log-Statistik abgleichen und ggf. anpassen.
- **`finance_push_dedupe`-Tabelle vs. In-Memory**: für Single-Instance
  genügt In-Memory, aber die DB-Variante übersteht Restarts. Empfehlung:
  DB-Variante (siehe §5).
- **Retry-After-Header**: muss `checkRateLimit` aktiv setzen lernen —
  der bestehende Code wirft nur `APIError`, ohne Header. Kleine
  Ergänzung in `user/rateLimiter.ts`, nicht in Finance.
- **`resetRateLimit` bei partiellem Erfolg**: TAN-Complete bei
  `state: "tan-required"` (Folge-TAN) — zählt das als Erfolg (reset)
  oder als Versuch? Vorschlag: als Erfolg zählen, weil der User auf
  dem richtigen Pfad ist.
