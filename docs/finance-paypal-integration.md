# Finance — PayPal-Integration

Anbindung von PayPal-Wallets über die OAuth 2.0 Authorization-Code-Pipeline
und die Reporting-API. Parallel zur FinTS-Integration, aber ohne
TAN-/PIN-Flow.

Status: Etappen 1–8 umgesetzt (Issue #427).

---

## 1. Datenmodell

`finance_bankcontact` trägt eine `access_type`-Diskriminator-Spalte
(`fints` | `paypal`). PayPal-Zugänge nutzen drei zusätzliche Spalten:

| Spalte | Bedeutung |
|---|---|
| `paypal_environment` | `sandbox` / `live` — pro Bankkontakt umschaltbar |
| `paypal_client_id`   | öffentliche PayPal-Kennung des verbundenen Kontos (payer_id aus dem OAuth-Callback) |
| `paypal_merchant_id` | für Webhook-Routing in Phase 2 vorgesehen |

Die FinTS-Felder (`blz`, `login`, `server_url`) sind für PayPal-Zeilen
nullable. Validierung passiert pro `access_type` in der App-Schicht
(`finance/bankcontacts.ts`).

`finance_account_balance` enthält seit Migration 0107 eine
`currency_code`-Spalte; der Primary Key ist auf
`(account_id, as_of, currency_code)` erweitert. So kann eine PayPal-
Wallet EUR- und USD-Stände zum selben Zeitstempel halten.

`finance_paypal_oauth_state` speichert den CSRF-`state` für laufende
OAuth-Flows mit 10-Minuten-TTL. Cleanup läuft im stündlichen
`finance-tan-cleanup`-Cron mit.

---

## 2. Credential-Storage

`finance/encryption.ts` exportiert eine diskriminierte Union:

```ts
type CredentialBundle =
  | { kind: "fints"; pin: string }
  | { kind: "paypal"; refreshToken?: string; accessToken?: string;
      accessTokenExpiresAt?: string };
```

PayPal-Bundles enthalten ausschließlich Nutzer-OAuth-Tokens. Die
App-eigenen Credentials (Client-ID/Secret pro Sandbox/Live) liegen in
Encore-Secrets — pro Bankkontakt **kein** geheimer Wert nötig.

Legacy-FinTS-PINs (vor Issue #427) bleiben rückwärtskompatibel lesbar.

---

## 3. OAuth-Flow

```
[UI] ── POST /finance/bankcontacts/:id/paypal/start ─────► [Encore]
                                                              │
                                                              │ insert state row
                                                              │ build auth_url
                                                              ▼
[UI] ◄────────── { auth_url, state, expires_at } ──────────────
       │
       │ window.location.href = auth_url
       ▼
[paypal.com] ── user authorises ──┐
                                  ▼
[Encore] ◄── GET …/paypal/callback?code=…&state=…
       │
       │ lookup state row, exchange code for tokens,
       │ fetch /v1/identity/openidconnect/userinfo,
       │ persist credential bundle + paypal_client_id,
       │ create finance_account (one wallet ↔ one account)
       ▼
302 ──► [UI] /finanzen/bankkontakte/:id?paypal=connected
```

Bei Fehlschlag: `?paypal=error&reason=…`. Beide Fälle räumt der
Frontend-View aus der URL und zeigt einen Hinweis.

Trennung über `POST /finance/bankcontacts/:id/paypal/disconnect` löscht
nur den Token-Blob — Konto und Buchungen bleiben erhalten.

---

## 4. Sync-Pipeline

`finance/statements.ts` routet anhand `access_type`:

- `fints`: bestehender Pfad (TAN-Flow, Multi-Account-Fetch).
- `paypal`: `runPaypalSync` zieht in einem Aufruf Balances und die
  letzten 30 Tage Transaktionen, persistiert über
  `persistPaypalSnapshot`.

`persistPaypalSnapshot`:
- ein `finance_account` pro Wallet (vom OAuth-Callback bereits angelegt),
- `dedupe_hash` = PayPal-`transaction_id` (stabil, opak, global eindeutig),
- pro Währung eine `finance_account_balance`-Zeile mit `source="paypal"`.

Die Cron in `statements-cron.ts` arbeitet beide Pfade ab — gleiche
`sync_times`-Slot-Auswertung wie FinTS.

---

## 5. Secrets & Environment

Pro Umgebung ein Paar PayPal-App-Credentials plus Callback- und
Frontend-URL. Die Encore-`secret()`-Namen sind in `infra-config.json`
auf Environment-Variablen gemappt — im Self-Host-Setup landen die
Werte ganz normal in der `.env` / `docker-compose.env`, der Code greift
nur über den Encore-Secret-Namen darauf zu.

| Secret-Name (Code) | Env-Variable (docker-compose) | Zweck |
|---|---|---|
| `PaypalAppClientIdSandbox`     | `PAYPAL_APP_CLIENT_ID_SANDBOX`     | Client-ID der Sandbox-App |
| `PaypalAppClientSecretSandbox` | `PAYPAL_APP_CLIENT_SECRET_SANDBOX` | Client-Secret der Sandbox-App |
| `PaypalAppClientIdLive`        | `PAYPAL_APP_CLIENT_ID_LIVE`        | Client-ID der Live-App |
| `PaypalAppClientSecretLive`    | `PAYPAL_APP_CLIENT_SECRET_LIVE`    | Client-Secret der Live-App |
| `PaypalRedirectUri`            | `PAYPAL_REDIRECT_URI`              | öffentliche URL des `paypal/callback`-Endpoints |

Zusätzlich liest `paypal-oauth.ts` `FRONTEND_BASE_URL` aus `process.env`
für das 302-Redirect zurück in die UI nach dem Token-Tausch.

Die PayPal-App registriert man unter dem PayPal Developer Dashboard mit
den Scopes:

- `openid` + `profile` (für Refresh-Token + `payer_id`)
- `https://uri.paypal.com/services/reporting/balances.read`
- `https://uri.paypal.com/services/reporting/search.read`

Für lokales `encore run` ohne Docker funktionieren stattdessen
`encore secret set --type local Paypal…`-Aufrufe (Werte landen
verschlüsselt in `.secrets.local.cue`).

---

## 6. Phase 2 — Webhooks

Nicht in diesem Track umgesetzt. Skizze: ein zentraler
`POST /finance/paypal/webhook`-Endpoint, Zuordnung Event → Bankkontakt
über `paypal_merchant_id`, Signatur-Verifizierung über
`/v1/notifications/verify-webhook-signature`. Polling bleibt parallel
als Safety-Net erhalten, ggf. mit reduzierter Frequenz.
