# Track M — E2E Tests (Maus & Tastatur)

End-to-end tests built with [Playwright](https://playwright.dev). Default
target: Chromium on Desktop. The suite is intentionally biased toward
realistic mouse and keyboard input — modifier-clicks, arrow-key
navigation, drag-and-drop, dialog Escape — because that's where the SPA
has the most surface area.

## Voraussetzungen

1. **Encore-Backend** läuft auf `http://localhost:4000` und hat den
   Seed mit Admin-Account angewandt:
   ```bash
   ADMIN_PASSWORD=admin encore run
   ```
2. **Vite-Dev-Server** wird automatisch von Playwright gestartet
   (siehe `playwright.config.ts → webServer`). Wer das selbst managen
   will, setzt `E2E_NO_WEBSERVER=1`.
3. Browser-Binaries einmalig installieren:
   ```bash
   npm run e2e:install
   ```

## Tests ausführen

```bash
# headless, alle Specs
npm run e2e

# interaktiver UI-Mode (empfohlen für Entwicklung)
npm run e2e:ui

# mit sichtbarem Browser
npm run e2e:headed

# Trace-Viewer / HTML-Report öffnen
npm run e2e:report

# Selektoren live aufzeichnen
npm run e2e:codegen
```

Filter auf einzelne Specs:
```bash
npm run e2e -- specs/login.spec.ts
npm run e2e -- -g "Multi-Select"
```

## Konfiguration über Umgebungsvariablen

| Variable             | Default                          | Zweck                                                  |
|----------------------|----------------------------------|--------------------------------------------------------|
| `E2E_BASE_URL`       | `http://localhost:5173/app/`     | SPA-Einstiegs-URL                                      |
| `E2E_API_URL`        | `http://localhost:4000`          | Encore-Backend für Setup-Login + Seeding               |
| `E2E_ADMIN_EMAIL`    | `admin@example.com`              | Test-Account                                           |
| `E2E_ADMIN_PASSWORD` | `admin`                          | Passwort des Test-Accounts                             |
| `E2E_NO_WEBSERVER`   | `unset`                          | Vite-Auto-Start unterdrücken (CI managt den Stack)     |
| `CI`                 | gesetzt im CI                    | Aktiviert Retries, GitHub-Reporter, `--forbid-only`    |

## Architektur

```
e2e/
├── playwright.config.ts   (im frontend/ root)
├── global-setup.ts        # Login einmal pro Run, schreibt storageState
├── fixtures/
│   ├── api.ts             # admin-API-Context für Daten-Seeding
│   └── auth.ts            # gotoApp / typeRealistic / clickWith
└── specs/
    ├── login.spec.ts      # Tastatur-Login, Tab-Reihenfolge, Fehler-Pfad
    ├── navigation.spec.ts # Hamburger-Menü, Submenu-Tab, Profil-Enter
    ├── gallery.spec.ts    # Multi-Select, Shift-/Strg-Klick, Pfeil+Enter
    ├── documents.spec.ts  # Suche-Debounce, Upload, Drag-and-Drop
    └── finance.spec.ts    # DataTable-Auswahl, Batch-Tag-Dialog, Escape
```

### Authentifizierung

`globalSetup` führt einen REST-Login gegen `${E2E_API_URL}/auth/login` aus
und schreibt `auth_token`, `refresh_token` und `auth_user` als
`storageState` nach `e2e/.auth/admin.json`. Der Auth-Store rehydriert beim
SPA-Boot aus exakt diesen `localStorage`-Keys, die einzelnen Specs starten
also angemeldet.

`login.spec.ts` setzt explizit `storageState: { cookies: [], origins: [] }`
und testet den Form-Pfad selbst.

### Selektoren

Wo möglich: `getByRole`, `getByLabel`, `getByPlaceholder`, `getByText`.
Wo unausweichlich (virtualisiertes Galerie-Grid, eigene Klassen):
`.vg-cell`, `.dropzone`, `.submenu-strip`. Falls ein Spec brüchig wird,
liefert er die direkte Begründung im Spec-Kommentar — bitte beim Anpassen
nicht stillschweigend wegcasten.

### Defensive Skips

Mehrere Specs rufen `test.skip()`, wenn das Test-Fixture-Set zu dünn ist
(z. B. weniger als 3 Fotos in der Galerie, kein finance.view-Recht). So
laufen die Tests gegen frisch geseedete und gegen reale Datenbanken,
ohne falsch-positive Fehler zu produzieren.

## CI-Hinweise

- `forbidOnly` greift, wenn `CI` gesetzt ist — vergessene `.only()`
  Marker brechen den Build ab.
- Reporter: `github` + `html`. Den Report-Folder als CI-Artefakt
  hochladen (`e2e/.report`).
- Bei Flakes liefert Trace mit dem ersten Retry: `trace: 'on-first-retry'`.
  Im CI also einfach `npm run e2e -- --reporter=github,html` und Trace via
  `playwright show-trace` öffnen.
