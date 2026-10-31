# Fotos: Einstellungen

Teil des Moduls Fotos (Rechte in `fotos-galerie.md`). Die Seiten unter
Fotos › Einstellungen steuern Import und Hintergrundverarbeitung.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `SCQ` | Scan-Queue | `/fotos/einstellungen/scan-queue` | `data.manage` |
| `WAR` | Wartung | `/fotos/einstellungen/wartung` | `data.manage` |
| `AES` | Ästhetik | `/fotos/einstellungen/aesthetik` | `data.manage` |
| `BIB` | Externe Bibliotheken | `/fotos/einstellungen/bibliotheken` | `photos.libraries.manage` |
| `OSM` | OSM-Regionen | `/fotos/einstellungen/osm` | `osm.admin` |
| `GEF` | Gefahrenzone | `/fotos/einstellungen/gefahrenzone` | `photos.purge` |

---

## SCQ: Scan-Queue

Stand der Dienste je Foto (Metadaten, Gesichter, Einbettung, OCR, POI,
Qualität) mit Zählern offen, läuft, fertig, Fehler und Fehlerdetails.

### FOT-SCQ-01 Scans steuern

- **Wo:** „Fehlende Scans starten“, „Alles neu scannen“, „n Fehler
  wiederholen“, „Scan abbrechen“, „POI für Altbilder nachholen“, „POI für
  trefferlose Fotos erneut prüfen“; „Fehlerdetails … anzeigen“ je Dienst
- **Recht:** `data.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken; „Alles neu scannen“ fragt nach.
- **Ergebnis:** Zähler laufen; Fortschritt auch unter Admin › Jobs.
- **Fehler und Grenzfälle:** Ein Dienst, der nicht erreichbar ist, steht
  rot mit der Meldung.
- **Test:** –

---

## WAR: Wartung

Karten „Ähnliche Fotos gruppieren“, „GPS-Koordinaten neu einlesen“,
„Auto-Crop neu berechnen“, „KI-Crop-Vorschläge neu berechnen“, „Metadaten
aktualisieren“.

### FOT-WAR-01 Gruppierung und Auto-Pick

- **Wo:** „Gruppen neu berechnen“, „KI-Picks neu berechnen“, „Bildmaße
  nachtragen“, „Gesichtsschärfe nachtragen“, „Gesichtslandmarken
  nachtragen“, „Kalibrierungs-Export herunterladen“, „KI auf meine
  Vorlieben kalibrieren“
- **Recht:** `data.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Job läuft; Gruppen und Picks ändern sich in Galerie und
  Review; die Kalibrierung lernt die Gewichte aus den eigenen
  Entscheidungen und zeigt den gemessenen Gewinn.
- **Fehler und Grenzfälle:** Offene Gruppen bleiben offen, geprüfte
  bleiben geprüft.
- **Test:** –

### FOT-WAR-02 GPS, Auto-Crop, Crop-Vorschläge, Metadaten

- **Wo:** die gleichnamigen Knöpfe
- **Recht:** `data.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken; optional nur Fotos ohne Wert.
- **Ergebnis:** Job läuft; Ort, Schnittvorschlag und Metadaten der Fotos
  werden aufgefrischt.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## AES: Ästhetik

Karten „Stand“ (Modell, letzter Lauf, Rückstand), „Vorläufiger Wert“,
„Auto-Pick nachspielen“, „Persönlicher Geschmack“, „Gesamtnote ohne
CLIP“, „Augen und Lächeln“, „Zeitfenster“, „Verlauf“. Hintergrund:
`documentation/plans/foto-aesthetik.md`.

### FOT-AES-01 Lauf starten, anhalten, alles neu bewerten

- **Wo:** Karte „Stand“: „Jetzt starten“, „Anhalten“, „Alle neu bewerten“
- **Recht:** `data.manage`
- **Vorbedingung:** aesthetic-service und GPU-Verleih erreichbar
- **Schritte:**
  1. Knopf drücken; „Alle neu bewerten“ fragt nach („Neu bewerten“).
- **Ergebnis:** Fortschritt „n von m Fotos dieses Laufs“; der Score steht
  danach als Ästhetik in Sortierung, Filter und Fotobuch.
- **Fehler und Grenzfälle:** Außerhalb des Zeitfensters startet nur der
  Knopf, nicht der Automat; wartet jemand auf das Sprachmodell, wartet
  der Lauf.
- **Test:** –

### FOT-AES-02 Zeitfenster und Schalter

- **Wo:** Karte „Zeitfenster“: Automatik an/aus, Beginn, Ende; „Speichern“
- **Recht:** `data.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Werte setzen, „Speichern“ (nur bei Änderung aktiv).
- **Ergebnis:** Der Automat läuft im Fenster, sobald das Modell frei
  ist; `last_tick` zeigt die letzte Prüfung.
- **Fehler und Grenzfälle:** Ab Werk ist die Automatik aus.
- **Test:** –

### FOT-AES-03 Vorläufigen Wert neu trainieren

- **Wo:** Karte „Vorläufiger Wert“, „Neu trainieren“
- **Recht:** `data.manage`
- **Vorbedingung:** Q-Align-Werte vorhanden
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Linearer Kopf wird neu gelernt und auf Fotos ohne
  Q-Align-Wert angewandt; die Karte zeigt, ob er besser trifft als die
  Zero-Shot-Prompts.
- **Fehler und Grenzfälle:** Zu wenige Werte: Hinweis statt Training.
- **Test:** –

### FOT-AES-04 Nachspielen und Gewichte übernehmen

- **Wo:** Karten „Auto-Pick nachspielen“, „Persönlicher Geschmack“,
  „Gesamtnote ohne CLIP“: „Nachspielen“, „Gewichte übernehmen“, „Neu
  lernen und übernehmen“, „Nur die Formel“, „Gesamtnote übernehmen“,
  „Bisherige Formel“
- **Recht:** `data.manage` (Ergebnis gilt je Nutzer)
- **Vorbedingung:** geprüfte Gruppen
- **Schritte:**
  1. „Nachspielen“; Treffer alt gegen neu lesen.
  2. Übernehmen nur, wenn ein Gewinn gemessen wurde; jede Übernahme fragt
     nach.
- **Ergebnis:** Auto-Pick rechnet mit den neuen Gewichten bzw. dem
  Geschmacksmodell.
- **Fehler und Grenzfälle:** Ohne gemessenen Gewinn ist Übernehmen
  gesperrt.
- **Test:** –

### FOT-AES-05 Augen und Lächeln auswerten

- **Wo:** Karte „Augen und Lächeln“, „Auswerten“
- **Recht:** `data.manage`
- **Vorbedingung:** Gesichtslandmarken nachgetragen
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Statistik, wie oft geschlossene Augen den Pick verändern.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-AES-06 Verlauf

- **Wo:** Karte „Verlauf“: Liste der Läufe mit Status (Läuft, Fertig,
  Angehalten, Fehler), „Lauf löschen“, „Verlauf leeren“
- **Recht:** `data.manage`
- **Vorbedingung:** Läufe
- **Schritte:**
  1. Drücken, Rückfrage bestätigen.
- **Ergebnis:** Einträge entfernt; die Scores bleiben.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## BIB: Externe Bibliotheken

Tabelle der registrierten Ordner mit Name, Pfad, Modus (Verlinken,
Verschieben), Auto-Import, Auto-Alben, Favorit ab, Ausgeschlossen,
Letzter Scan, Scan-Status, Aktionen.

### FOT-BIB-01 Bibliothek anlegen oder bearbeiten

- **Wo:** „Neue Bibliothek“; Stift in der Zeile
- **Recht:** `photos.libraries.manage`
- **Vorbedingung:** Ordner auf dem Server erreichbar
- **Schritte:**
  1. Dialog: Name, Pfad über den Ordnerbrowser („Wählen“, „Aktuellen
     Ordner wählen“), Modus (Verlinken: Datei bleibt am Ort; Verschieben:
     in das Upload-Verzeichnis), Auto-Import, Auto-Alben aus Unterordnern,
     Favorit ab (Bewertung), Ausschlussliste („Pfad eingeben, z.B.
     2020/urlaub“, „Ausschließen“).
  2. „Anlegen“ bzw. „Speichern“.
- **Ergebnis:** Zeile in der Tabelle; der erste Scan startet.
- **Fehler und Grenzfälle:** Ein schon registrierter Ordner wird
  gemeldet („Aktueller Ordner bereits registriert“).
- **Test:** –

### FOT-BIB-02 Scan starten, Fehler lesen

- **Wo:** „Scan“ in der Zeile; Scan-Status mit „Fehlerdetails“
- **Recht:** `photos.libraries.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Neue Dateien werden importiert, Fortschritt in der
  Spalte; Fehlerdetails im Dialog.
- **Fehler und Grenzfälle:** Verlinkte Fotos lassen sich in der Galerie
  nicht löschen (`FOT-GAL-17`).
- **Test:** –

### FOT-BIB-03 Bibliothek entfernen

- **Wo:** Papierkorb; Dialog „Bibliothek entfernen“
- **Recht:** `photos.libraries.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. „Entfernen“.
- **Ergebnis:** Registrierung weg; verlinkte Fotos verschwinden aus der
  Sammlung, die Dateien bleiben.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## OSM: OSM-Regionen

Regionen für Reverse-Geocoding und POI-Suche aus OpenStreetMap-Auszügen.

### FOT-OSM-01 Region vorschlagen und anlegen

- **Wo:** Felder Breite/Länge, „Region vorschlagen“, „Regionen aus
  Foto-Bibliothek vorschlagen“, „Anlegen“
- **Recht:** `osm.admin`
- **Vorbedingung:** Netzwerk zu den Auszügen
- **Schritte:**
  1. Vorschlagen, Treffer prüfen, „Anlegen“.
- **Ergebnis:** Region importiert; Status in der Tabelle; redundante
  Regionen (durch Subregionen abgedeckt) tragen ein Badge.
- **Fehler und Grenzfälle:** Import läuft als Job.
- **Test:** –

### FOT-OSM-02 Region pflegen

- **Wo:** „Freigeben“, „Aktualisieren“, „DB-Größe“, „Entfernen“, „Ältere
  Importe suchen“, „Diese Regionen neu importieren“, „Reverse-Geocode
  testen“
- **Recht:** `osm.admin`
- **Vorbedingung:** Region
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Region aktiv, neu importiert, gemessen oder entfernt;
  der Test zeigt die Adresse zu den eingegebenen Koordinaten.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## GEF: Gefahrenzone

### FOT-GEF-01 Alle Fotodaten löschen

- **Wo:** „Alle Fotodaten löschen…“; Dialog „Alle Fotodaten löschen“
- **Recht:** `photos.purge`
- **Vorbedingung:** keine
- **Schritte:**
  1. Modus wählen: nur Datenbank („Datenbank leeren“) oder Datenbank und
     Dateien („Alles endgültig löschen“); Bestätigungstext eingeben.
  2. Knopf drücken.
- **Ergebnis:** Alle Fotos, Alben, Gesichter und Scans sind weg; der
  Dialog zeigt den Abschluss.
- **Fehler und Grenzfälle:** keine Wiederherstellung; externe
  Bibliotheken bleiben registriert und lassen sich neu scannen.
- **Test:** –

---

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| FOT-SCQ-01 | Scans steuern | data.manage | – |
| FOT-WAR-01 | Gruppierung und Auto-Pick | data.manage | – |
| FOT-WAR-02 | GPS, Auto-Crop, Crop-Vorschläge, Metadaten | data.manage | – |
| FOT-AES-01 | Lauf starten, anhalten, neu bewerten | data.manage | – |
| FOT-AES-02 | Zeitfenster und Schalter | data.manage | – |
| FOT-AES-03 | Vorläufigen Wert neu trainieren | data.manage | – |
| FOT-AES-04 | Nachspielen und Gewichte übernehmen | data.manage | – |
| FOT-AES-05 | Augen und Lächeln auswerten | data.manage | – |
| FOT-AES-06 | Verlauf | data.manage | – |
| FOT-BIB-01 | Bibliothek anlegen oder bearbeiten | libraries.manage | – |
| FOT-BIB-02 | Scan starten, Fehler lesen | libraries.manage | – |
| FOT-BIB-03 | Bibliothek entfernen | libraries.manage | – |
| FOT-OSM-01 | Region vorschlagen und anlegen | osm.admin | – |
| FOT-OSM-02 | Region pflegen | osm.admin | – |
| FOT-GEF-01 | Alle Fotodaten löschen | photos.purge | – |
