# Admin

Benutzer, Rollen, eingeplante Jobs und Systemstatus. Die früheren
Admin-Seiten Datenverwaltung, Bibliotheken, Taxonomie und KI-Modell
liegen in den Modulen (Fotos, Dokumente, Finanzen › Einstellungen); die
alten Pfade leiten um.

**Modulrecht:** `users.list` schaltet den Menüpunkt „Admin“ frei.
Darunter: `users.read`, `users.delete`, `roles.list`, `roles.manage`,
`data.manage` (Jobs, Systemstatus).

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `BEN` | Benutzer | `/admin` | `users.list` |
| `BED` | Benutzer | `/admin/benutzer/:id` | `users.read` |
| `ROL` | Rollen & Berechtigungen | `/admin/rollen` | `roles.list` |
| `JOB` | Eingeplante Jobs | `/admin/jobs` | `data.manage` |
| `STA` | Systemstatus | `/admin/status` | `data.manage` |

---

## BEN: Benutzer (`/admin`)

Tabelle mit ID, Name, E-Mail, Rollen, Erstellt am; darunter
„Einladungen“ mit E-Mail und Status.

### ADM-BEN-01 Benutzer einladen

- **Wo:** „Einladen“; Dialog „Benutzer einladen“ mit E-Mail,
  „Einladung verschicken“
- **Recht:** `users.list` und Mailversand
- **Vorbedingung:** keine
- **Schritte:**
  1. Adresse (zum Beispiel `max@beispiel.test`), senden.
- **Ergebnis:** Eintrag unter „Einladungen“ mit Status „offen“; die
  Person registriert sich über den Link (`allgemein.md`, REG).
- **Fehler und Grenzfälle:** Eine schon registrierte Adresse wird
  abgewiesen. „Zurückziehen“ macht die Einladung ungültig.
- **Test:** –

### ADM-BEN-02 Suchen und Benutzer öffnen

- **Wo:** Suchfeld; Zeile
- **Recht:** `users.list`; öffnen `users.read`
- **Vorbedingung:** keine
- **Schritte:**
  1. Name oder E-Mail eingeben; Zeile anklicken.
- **Ergebnis:** `BED`; Zurück landet auf der Zeile.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## BED: Benutzer (`/admin/benutzer/:id`)

### ADM-BED-01 Rolle zuweisen oder entziehen

- **Wo:** Auswahl „Rolle auswählen“ und „Zuweisen“; Kreuz „Rolle
  entziehen“ am Chip, Dialog „Rolle entfernen“
- **Recht:** `roles.manage`
- **Vorbedingung:** Rollen vorhanden
- **Schritte:**
  1. Rolle wählen, „Zuweisen“; zum Entziehen Kreuz und „Entfernen“.
- **Ergebnis:** Chips ändern sich; der Nutzer hat die Rechte ab dem
  nächsten Laden seiner Seite.
- **Fehler und Grenzfälle:** Die eigene Admin-Rolle lässt sich nicht
  entziehen, wenn sonst kein Admin bliebe.
- **Test:** –

### ADM-BED-02 Benutzer löschen

- **Wo:** „Benutzer löschen“; Dialog „Benutzer löschen“
- **Recht:** `users.delete`
- **Vorbedingung:** keine
- **Schritte:**
  1. „Löschen“.
- **Ergebnis:** Konto weg; zurück zu `BEN`.
- **Fehler und Grenzfälle:** Eigene Daten des Nutzers (Fotos, Dokumente)
  bleiben nach den Regeln des Moduls; der Dialog nennt, was passiert.
- **Test:** –

---

## ROL: Rollen & Berechtigungen (`/admin/rollen`)

Tabelle mit ID, Name, Beschreibung, Berechtigungen (Chips), Aktionen.

### ADM-ROL-01 Rolle anlegen

- **Wo:** Felder „Rollenname“, „Beschreibung (optional)“, „Erstellen“
- **Recht:** `roles.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Name, „Erstellen“.
- **Ergebnis:** Zeile ohne Berechtigungen.
- **Fehler und Grenzfälle:** Doppelter Name wird abgewiesen.
- **Test:** –

### ADM-ROL-02 Berechtigungen bearbeiten

- **Wo:** Stift in der Zeile; Dialog „Berechtigungen: <Rolle>“ mit
  Gruppen je Domäne
- **Recht:** `roles.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Schlüssel anhaken oder abhaken, speichern.
- **Ergebnis:** Chips in der Zeile; alle Nutzer mit der Rolle haben die
  Rechte.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### ADM-ROL-03 Rolle löschen

- **Wo:** Papierkorb „Rolle löschen“; Dialog
- **Recht:** `roles.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. „Löschen“.
- **Ergebnis:** Rolle weg, bei allen Nutzern entfernt.
- **Fehler und Grenzfälle:** Systemrollen (Admin, Assistent User,
  Foto-Genehmiger) lassen sich nicht löschen.
- **Test:** –

---

## JOB: Eingeplante Jobs (`/admin/jobs`)

Jobs nach Dienst gruppiert mit Zeitplan, letztem und nächstem Lauf,
Status.

### ADM-JOB-01 Job pausieren, fortsetzen, jetzt ausführen

- **Wo:** „Pausieren“, „Resume“, „Jetzt ausführen“ je Job;
  „Aktualisieren“ oben; Suchfeld
- **Recht:** `data.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Status wechselt; ein manueller Lauf steht mit Zeitstempel.
- **Fehler und Grenzfälle:** Ein laufender Job lässt sich nicht erneut
  starten.
- **Test:** –

---

## STA: Systemstatus (`/admin/status`)

Kacheln der Warteschlangen (offen, Fehler) mit „Öffnen“ zur
Modulseite, Abschnitt „Dienste“ mit Erreichbarkeit (llm-service,
Embedding, Gesichter, OCR, Routing), Build-Information, Demodaten
(solange das System unberührt ist).

### ADM-STA-01 Warteschlange öffnen

- **Wo:** „Öffnen“ an der Kachel
- **Recht:** `data.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Scan-Queue, Dokument-Queue oder KI-Tagging im Modul.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### ADM-STA-02 Reisezeiten vergleichen

- **Wo:** Kachel „Routing“, „Reisezeiten vergleichen“ / „Erneut
  vergleichen“
- **Recht:** `data.manage`
- **Vorbedingung:** Routing-Dienst konfiguriert
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Messung der Antwortzeiten der Routing-Quellen.
- **Fehler und Grenzfälle:** Ohne Dienst steht „nicht konfiguriert“.
- **Test:** –

### ADM-STA-03 Demodaten anlegen oder entfernen

- **Wo:** Karte „Demodaten“ (nur solange keine Nutzdaten existieren)
- **Recht:** `data.manage`
- **Vorbedingung:** unberührtes System
- **Schritte:**
  1. „Demodaten anlegen“, später „Demodaten entfernen“.
- **Ergebnis:** Beispielkonten, Dokumente, Buchungen, Fotos und ein
  zweiter Demo-Nutzer; Entfernen nimmt alles zurück.
- **Fehler und Grenzfälle:** Plan `documentation/plans/demodaten.md`;
  die Etappen sind offen, die Karte erscheint erst mit der Umsetzung.
- **Test:** –

---

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| ADM-BEN-01 | Benutzer einladen | users.list | – |
| ADM-BEN-02 | Suchen und Benutzer öffnen | users.read | – |
| ADM-BED-01 | Rolle zuweisen oder entziehen | roles.manage | – |
| ADM-BED-02 | Benutzer löschen | users.delete | – |
| ADM-ROL-01 | Rolle anlegen | roles.manage | – |
| ADM-ROL-02 | Berechtigungen bearbeiten | roles.manage | – |
| ADM-ROL-03 | Rolle löschen | roles.manage | – |
| ADM-JOB-01 | Job pausieren, fortsetzen, ausführen | data.manage | – |
| ADM-STA-01 | Warteschlange öffnen | data.manage | – |
| ADM-STA-02 | Reisezeiten vergleichen | data.manage | – |
| ADM-STA-03 | Demodaten (geplant) | data.manage | – |
