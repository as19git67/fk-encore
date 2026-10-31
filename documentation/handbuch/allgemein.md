# Allgemein: Anmelden, Profil, Navigation

Was in jedem Modul gleich ist: Anmeldung, Registrierung, Passwort,
Profil, Hauptmenü, Untermenü, Einstellungen-Zahnrad, Basket-Knopf,
Assistent-Symbol und die gemeinsamen Muster (Listen-Toolbar,
Auswahlleiste, Dialoge, Zurück-Navigation). Die Muster selbst sind in
`.claude/CLAUDE.md` beschrieben; hier stehen die Handgriffe.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `LOG` | Anmelden | `/login` | – |
| `REG` | Konto anlegen | `/register` (mit Einladungstoken) | – |
| `PWD` | Passwort vergessen / Neues Passwort setzen | `/forgot-password`, `/forgot-password?token=…` | – |
| `PRO` | Mein Profil | `/profile` | angemeldet |
| `NAV` | Hauptmenü und Untermenü | jede Seite | angemeldet |

---

## LOG: Anmelden (`/login`)

### ALG-LOG-01 Mit E-Mail und Passwort anmelden

- **Wo:** Felder „E-Mail“, Passwort mit Auge „Passwort anzeigen“, Knopf
  „Anmelden“
- **Recht:** –
- **Vorbedingung:** Konto vorhanden
- **Schritte:**
  1. E-Mail, Passwort, „Anmelden“ (Enter reicht).
- **Ergebnis:** Weiterleitung auf `redirect` aus der URL oder das erste
  Modul, das der Nutzer nutzen darf.
- **Fehler und Grenzfälle:** Falsches Passwort zeigt die Fehlermeldung,
  das E-Mail-Feld bleibt gefüllt. Tab-Reihenfolge E-Mail → Passwort →
  Anmelden.
- **Test:** `login.spec.ts` (Tab-Reihenfolge, falsches Passwort,
  Passwort-Toggle)

### ALG-LOG-02 Mit Passkey anmelden

- **Wo:** „Mit Passkey anmelden“
- **Recht:** –
- **Vorbedingung:** Passkey registriert (`ALG-PRO-05`)
- **Schritte:**
  1. Knopf, Browser-Dialog bestätigen.
- **Ergebnis:** angemeldet wie `ALG-LOG-01`.
- **Fehler und Grenzfälle:** Abbruch im Browser-Dialog lässt die Seite
  unverändert.
- **Test:** –

### ALG-LOG-03 Abmelden

- **Wo:** Knopf „Abmelden“ rechts im Hauptmenü
- **Recht:** angemeldet
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Sitzung beendet, `/login`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## REG: Konto anlegen (`/register`)

### ALG-REG-01 Registrieren über Einladung

- **Wo:** Felder Name, E-Mail, Passwort, Knopf „Konto anlegen“
- **Recht:** gültiger Einladungslink (`admin.md`, ADM-BEN-01)
- **Vorbedingung:** keine
- **Schritte:**
  1. Felder füllen, „Konto anlegen“.
- **Ergebnis:** Konto mit den Rollen der Einladung; angemeldet.
- **Fehler und Grenzfälle:** Abgelaufene oder zurückgezogene Einladung
  zeigt einen Hinweis; ohne Einladung ist die Registrierung geschlossen.
- **Test:** –

---

## PWD: Passwort vergessen

### ALG-PWD-01 Zurücksetzungslink anfordern

- **Wo:** Feld „E-Mail“, „Zurücksetzungslink anfordern“
- **Recht:** –
- **Vorbedingung:** Mailversand konfiguriert
- **Schritte:**
  1. Adresse, senden.
- **Ergebnis:** Hinweis, dass eine E-Mail unterwegs ist (auch bei
  unbekannter Adresse, ohne sie zu verraten).
- **Fehler und Grenzfälle:** keine
- **Test:** –

### ALG-PWD-02 Neues Passwort setzen

- **Wo:** Link aus der E-Mail (`?token=…`), Felder neues Passwort und
  Bestätigung, „Passwort zurücksetzen“, danach „Zur Anmeldung“
- **Recht:** gültiger Token
- **Vorbedingung:** keine
- **Schritte:**
  1. Passwort zweimal, senden.
- **Ergebnis:** Passwort gesetzt, alle anderen Sitzungen abgemeldet.
- **Fehler und Grenzfälle:** Abgelaufener Token: Hinweis mit Weg zu
  `ALG-PWD-01`.
- **Test:** –

---

## PRO: Mein Profil (`/profile`)

Karten: Konto (Name, E-Mail, Rollen), Postanschrift, Passwort,
Benachrichtigungen (Push je Gerät, Arten), Sitzungen, Passkeys.

### ALG-PRO-01 Postanschrift speichern

- **Wo:** Feld „Postanschrift“ (Straße Hausnummer, PLZ Ort), „Anschrift
  speichern“
- **Recht:** angemeldet
- **Vorbedingung:** keine
- **Schritte:**
  1. Eingeben, speichern.
- **Ergebnis:** Die Anschrift steht als Absender in Briefen des
  Assistenten.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### ALG-PRO-02 Passwort ändern

- **Wo:** „Aktuelles Passwort“, „Neues Passwort“, „Neues Passwort
  bestätigen“, „Passwort ändern“
- **Recht:** angemeldet
- **Vorbedingung:** keine
- **Schritte:**
  1. Felder, Knopf.
- **Ergebnis:** Toast; andere Sitzungen bleiben.
- **Fehler und Grenzfälle:** Falsches aktuelles Passwort oder ungleiche
  Bestätigung: Fehlermeldung an der Karte.
- **Test:** –

### ALG-PRO-03 Push-Benachrichtigungen

- **Wo:** Karte Benachrichtigungen: „Aktivieren“ / „Deaktivieren“ für
  dieses Gerät; je Art (Kommentar, Reaktion, Freigabe, Fotos
  hochgeladen, …) „Aktivieren“ / „Deaktivieren“
- **Recht:** angemeldet
- **Vorbedingung:** Browser erlaubt Benachrichtigungen
- **Schritte:**
  1. Aktivieren, Browser-Frage bestätigen; Arten wählen.
- **Ergebnis:** Push-Nachrichten kommen auf diesem Gerät an.
- **Fehler und Grenzfälle:** Verweigert der Browser, steht der Grund an
  der Karte.
- **Test:** –

### ALG-PRO-04 Sitzungen verwalten

- **Wo:** Liste der Geräte mit „Gerät abmelden“; „Alle abmelden“
- **Recht:** angemeldet
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Die Sitzung des Geräts endet beim nächsten Aufruf.
- **Fehler und Grenzfälle:** „Alle abmelden“ meldet auch dieses Gerät
  ab.
- **Test:** –

### ALG-PRO-05 Passkey registrieren oder löschen

- **Wo:** Feld „Name für den Passkey (optional)“, „Neuen Passkey
  registrieren“; Tabelle mit Name, Gerätetyp, Backup, Erstellt am,
  „Passkey löschen“
- **Recht:** angemeldet
- **Vorbedingung:** Browser mit WebAuthn
- **Schritte:**
  1. Knopf, Browser-Dialog.
- **Ergebnis:** Zeile in der Tabelle; Anmeldung über `ALG-LOG-02`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## NAV: Hauptmenü und Untermenü

Zeile 1: Hamburger „Module“ mit dem Modulwechsler, Name des aktiven
Moduls; rechts Assistent (mit `module.assistant`), Basket (wer einen Typ
ablegen darf), Zahnrad „Einstellungen“ (Einstellungen des Moduls, dann
„Mein Profil“), „Abmelden“. Zeile 2: Untermenü des Moduls; Gruppen
(„Steuer“, „Einstellungen“) öffnen ein Popup. Darunter der Sticky-Stack
mit Titel, Toolbar, Hinweis und Auswahlleiste der Seite.

### ALG-NAV-01 Modul wechseln

- **Wo:** Hamburger „Module“
- **Recht:** Modulrecht des Ziels
- **Vorbedingung:** mindestens zwei Module erlaubt
- **Schritte:**
  1. Menü öffnen, Modul wählen (Pfeiltasten und Enter gehen).
- **Ergebnis:** Startseite des Moduls; der Modulname in der Kopfzeile
  wechselt.
- **Fehler und Grenzfälle:** Module ohne Recht fehlen im Menü.
- **Test:** `navigation.spec.ts` („Hamburger-Menü per Maus öffnet
  Modulauswahl, Pfeil/Enter wechselt Modul“)

### ALG-NAV-02 Untermenü nutzen

- **Wo:** Zeile 2
- **Recht:** Recht des Eintrags
- **Vorbedingung:** keine
- **Schritte:**
  1. Eintrag anklicken; Gruppen öffnen ein Popup; Tab läuft in
     DOM-Reihenfolge durch.
- **Ergebnis:** Seite wechselt; auf schmalen Bildschirmen zeigen Einträge
  nur Symbole mit Tooltip.
- **Fehler und Grenzfälle:** keine
- **Test:** `navigation.spec.ts` („Tastatur-Fokus durchläuft
  Submenu-Strip“)

### ALG-NAV-03 Einstellungen-Zahnrad und Profil

- **Wo:** Zahnrad „Einstellungen“
- **Recht:** angemeldet
- **Vorbedingung:** keine
- **Schritte:**
  1. Öffnen (Enter geht); Eintrag wählen; „Mein Profil“ zuunterst.
- **Ergebnis:** Einstellungsseite des Moduls oder `PRO`.
- **Fehler und Grenzfälle:** Einträge ohne Recht fehlen.
- **Test:** `navigation.spec.ts` („Einstellungen (icon-only) hat
  aria-label, öffnet per Enter und führt zum Profil“)

### ALG-NAV-04 Assistent und Basket aus der Kopfzeile

- **Wo:** Chat-Symbol „Assistent“, Basket-Knopf
- **Recht:** `module.assistant` bzw. ein ablegbarer Typ
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** `/assistent` bzw. Basket-Schublade (`sammelmappen.md`).
- **Fehler und Grenzfälle:** keine
- **Test:** –

### ALG-NAV-05 Gemeinsame Tastaturkürzel

- **Wo:** jede Listen-Seite
- **Recht:** –
- **Vorbedingung:** keine
- **Schritte:**
  1. `/` fokussiert die Suche; Escape im Suchfeld leert sie; Escape
     außerhalb beendet den Auswahlmodus; Strg/Cmd+A wählt alles im
     Auswahlmodus; Umschalt+Klick wählt den Bereich.
- **Ergebnis:** wie beschrieben in jedem Modul gleich.
- **Fehler und Grenzfälle:** In einem Dialog gelten die Kürzel nicht.
- **Test:** –

### ALG-NAV-06 Zurück und Scroll-Position

- **Wo:** Zurück-Pfeil jeder Detailseite; Browser-Zurück
- **Recht:** –
- **Vorbedingung:** keine
- **Schritte:**
  1. Zurück.
- **Ergebnis:** Die Liste steht wieder auf der Zeile, von der aus geöffnet
  wurde (Anker), mit Fokusring; Scroll-Offset nur bei Browser-Zurück.
- **Fehler und Grenzfälle:** Kam der Nutzer aus einem anderen Modul
  (Assistent, Sammelmappen), führt der Pfeil dorthin zurück; sonst in
  die Liste des Moduls.
- **Test:** –

### ALG-NAV-07 Hell/Dunkel

- **Wo:** folgt der Systemeinstellung des Geräts
- **Recht:** –
- **Vorbedingung:** keine
- **Schritte:**
  1. Systemthema wechseln.
- **Ergebnis:** Alle Seiten wechseln; nur der schwarze Vollbild-Betrachter
  bleibt gleich.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| ALG-LOG-01 | Mit E-Mail und Passwort anmelden | – | `login.spec.ts` |
| ALG-LOG-02 | Mit Passkey anmelden | – | – |
| ALG-LOG-03 | Abmelden | angemeldet | – |
| ALG-REG-01 | Registrieren über Einladung | Einladung | – |
| ALG-PWD-01 | Zurücksetzungslink anfordern | – | – |
| ALG-PWD-02 | Neues Passwort setzen | Token | – |
| ALG-PRO-01 | Postanschrift speichern | angemeldet | – |
| ALG-PRO-02 | Passwort ändern | angemeldet | – |
| ALG-PRO-03 | Push-Benachrichtigungen | angemeldet | – |
| ALG-PRO-04 | Sitzungen verwalten | angemeldet | – |
| ALG-PRO-05 | Passkey registrieren oder löschen | angemeldet | – |
| ALG-NAV-01 | Modul wechseln | Modulrecht | `navigation.spec.ts` |
| ALG-NAV-02 | Untermenü nutzen | – | `navigation.spec.ts` |
| ALG-NAV-03 | Einstellungen-Zahnrad und Profil | angemeldet | `navigation.spec.ts` |
| ALG-NAV-04 | Assistent und Basket aus der Kopfzeile | – | – |
| ALG-NAV-05 | Gemeinsame Tastaturkürzel | – | – |
| ALG-NAV-06 | Zurück und Scroll-Position | – | – |
| ALG-NAV-07 | Hell/Dunkel | – | – |
