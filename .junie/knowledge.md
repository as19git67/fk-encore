# Projekt-Erkenntnisse (Junie Knowledge Base)

Dieses Dokument dient dazu, wichtige Erkenntnisse und architektonische Entscheidungen festzuhalten, damit sie für zukünftige Tasks und Sessions zur Verfügung stehen.

## 1. Terminologie-Änderung: Haushalt -> Gruppe
- Das Konzept der **„Haushalte“** wurde vollständig durch **„Gruppen“** ersetzt.
- Dies betrifft:
    - Datenbank-Tabellen: `groups`, `group_members`.
    - Spalten: `group_id`.
    - API-Endpunkte: `/groups` statt `/households`.
    - Frontend-Routen: `/gruppen`.
    - Sichtbarkeits-Enum: `group` statt `household`.
- **Wichtig:** Physische Speicherpfade für Dokumente in Gruppen verwenden nun das Präfix `_gruppe` (in `documents.service.ts` definiert).

## 2. Datenbank-Migrationen (Drizzle Kit)
- Das Projekt verwendet Drizzle für Datenbank-Migrationen.
- **Fallstrick:** Migrationen werden nur dann automatisch ausgeführt, wenn sie im Migrations-Journal unter `db/migrations/postgres/meta/_journal.json` registriert sind.
- Wenn eine neue `.sql`-Datei manuell hinzugefügt oder verschoben wird, muss der entsprechende Eintrag im Journal vorhanden sein, sonst ignoriert die App die Migration beim Start.

## 3. Dokumenten-Sichtbarkeit
- Dokumente können `private` oder `group` sein.
- Die Zugriffskontrolle erfolgt über die `visibility.ts` im Backend, die prüft, ob ein Nutzer Mitglied der zugewiesenen `group_id` ist.

## 4. Frontend-Struktur
- Framework: Vue 3 mit PrimeVue.
- API-Calls sind in `frontend/src/api/` zentralisiert.
- CSS: Verwendet PrimeVue-Variablen (z. B. `--p-content-background`), was in manchen Linter-Konfigurationen Warnungen verursachen kann.

## 5. Backend (Encore)
- Das Backend basiert auf dem Encore-Framework.
- Services sind in Verzeichnissen wie `documents/`, `finance/`, `user/` organisiert.
