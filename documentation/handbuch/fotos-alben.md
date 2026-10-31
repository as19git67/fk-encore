# Fotos: Alben und geteilte Alben

Teil des Moduls Fotos (Rechte und Begriffe in `fotos-galerie.md`). Ein
Album ist eine benannte Sammlung von Fotos mit Besitzer, optionaler
Karte, Titelbild und Freigaben an Nutzer (Nur lesen, Bearbeiten,
Bearbeiten + Teilen) oder über einen öffentlichen Link für Gäste.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `ALB` | Meine Alben | `/fotos/alben` | `photos.view` |
| `ALD` | Album | `/fotos/alben/:id` | `photos.view` und Zugriff auf das Album |
| `GTA` | Geteiltes Album (Gast) | `/albums/shared/:token` | kein Login |

---

## ALB: Meine Alben (`/fotos/alben`)

Kacheln der Alben mit Titelbild, Name, Fotozahl und Rolle (eigen oder
geteilt); Toolbar mit Suche, Filter, Sortierung und Ansicht.

### FOT-ALB-01 Album anlegen

- **Wo:** Knopf „Neues Album“ (auch im leeren Zustand)
- **Recht:** `albums.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Dialog „Neues Album erstellen“: Name (zum Beispiel `Sommer 2026`),
     optional Beschreibung.
  2. „Erstellen“.
- **Ergebnis:** Album öffnet sich leer (`ALD`).
- **Fehler und Grenzfälle:** Gibt es schon ein eigenes Album mit dem
  Namen, warnt der Dialog, sperrt „Erstellen“ und bietet „Öffnen“ an.
- **Test:** –

### FOT-ALB-02 Suchen, filtern, sortieren

- **Wo:** Toolbar; Dialog „Filter“ mit Besitz (Alle, Eigene, Geteilt mit
  mir), Karte (Alle, Ohne Karte, Mit Karte), Leere (Alle, Nur leere, Ohne
  leere); Sortierung Neuestes Foto, Name, Erstellungsdatum, Foto-Anzahl
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Werte setzen, „Anwenden“.
- **Ergebnis:** Kacheln folgen; alles in der URL; leerer Treffer zeigt
  „Keine Alben passen zur Suche“.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-ALB-03 Album öffnen

- **Wo:** Kachel
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Kachel anklicken.
- **Ergebnis:** `ALD`; Zurück landet auf der Kachel.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-ALB-04 Album ablegen

- **Wo:** „Ablegen“ im Kachelmenü oder in der Auswahlleiste
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Ziel wählen.
- **Ergebnis:** Album liegt als Ganzes im Basket oder in der Mappe
  (`sammelmappen.md`).
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## ALD: Album (`/fotos/alben/:id`)

Raster wie die Galerie, dazu Karte (falls aktiviert) mit Umschalter
Raster/Karte, Titelzeile mit Zurück („Zurück zur Albumübersicht“ bzw.
„Zurück zum Feed“) und den Aktionen Hochladen, Freigeben,
Album-Einstellungen, Fotobuch gestalten, Cover fokussieren, Gruppen
bearbeiten und für Gäste eines geteilten Albums „Freigabe verlassen“.
Suche, Filter, Sortierung, Auswahl, Vollbild und Seitenleiste
funktionieren wie in der Galerie (`FOT-GAL-01` bis `FOT-GAL-08`,
`FOT-VOL-*`, `FOT-DET-*`) und werden hier nicht wiederholt.

### FOT-ALD-01 Fotos hochladen

- **Wo:** Knopf „Fotos hochladen“; Drag-and-drop
- **Recht:** `photos.upload` und Rolle Besitzer oder Bearbeiter
- **Vorbedingung:** keine
- **Schritte:**
  1. Dateien wählen.
- **Ergebnis:** Fotos liegen im Album und in der Galerie des Uploaders.
- **Fehler und Grenzfälle:** wie `FOT-GAL-07`; mit Rolle „Nur lesen“
  fehlt der Knopf.
- **Test:** –

### FOT-ALD-02 Album-Einstellungen

- **Wo:** Knopf „Album-Einstellungen“
- **Recht:** Besitzer oder Bearbeiter
- **Vorbedingung:** keine
- **Schritte:**
  1. Dialog: Name, Beschreibung, „Karte aktivieren“, „Ähnliche Fotos:
     Reviews der anderen“ (Wie global eingestellt, Reviews der anderen
     übernehmen, Selbst entscheiden).
  2. „Speichern“.
- **Ergebnis:** Titel, Karte und Übernahme-Regel gelten.
- **Fehler und Grenzfälle:** Ein Name, den ein anderes eigenes Album
  trägt, wird gewarnt. „Album löschen“ steht links im selben Dialog
  (`FOT-ALD-03`).
- **Test:** –

### FOT-ALD-03 Album löschen

- **Wo:** „Album löschen“ im Einstellungsdialog
- **Recht:** Besitzer
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf, Dialog „Album löschen“ mit „Willst du dieses Album wirklich
     löschen?“, „Löschen“.
- **Ergebnis:** Album und Freigaben sind weg, die Fotos bleiben in der
  Galerie; Seite kehrt zu `ALB` zurück.
- **Fehler und Grenzfälle:** keine Wiederherstellung.
- **Test:** –

### FOT-ALD-04 Album an Nutzer freigeben

- **Wo:** Knopf „Freigeben“, Dialog „Album freigeben“, Abschnitt
  „Benutzer hinzufügen“
- **Recht:** Besitzer oder Rolle „Bearbeiten + Teilen“
- **Vorbedingung:** weitere Nutzer im System
- **Schritte:**
  1. „Benutzer auswählen…“, Stufe (Nur lesen, Bearbeiten, Bearbeiten +
     Teilen; die letzte nur als Besitzer), „Freigeben“.
  2. Unter „Aktuelle Freigaben“ Stufe ändern oder Freigabe entfernen.
- **Ergebnis:** Der Nutzer sieht das Album unter „Geteilt mit mir“ und
  dessen Fotos in seiner Galerie; er bekommt einen Eintrag unter
  Aktivität.
- **Fehler und Grenzfälle:** Schon freigegebene Nutzer fehlen in der
  Auswahl.
- **Test:** –

### FOT-ALD-05 Öffentlichen Link erstellen und zurücknehmen

- **Wo:** Dialog „Album freigeben“, Abschnitt „Öffentlicher Link“
- **Recht:** Besitzer oder „Bearbeiten + Teilen“
- **Vorbedingung:** keine
- **Schritte:**
  1. Gültigkeit wählen (Unbegrenzt, 7, 30, 90 Tage), „Link erstellen“.
  2. Link kopieren; „Link löschen“ macht ihn ungültig.
- **Ergebnis:** „Jeder mit dem Link kann das Album ansehen“ (`GTA`);
  sichtbar sind nur Fotos, deren Link-Sichtbarkeit es erlaubt.
- **Fehler und Grenzfälle:** Abgelaufene Links zeigen dem Gast einen
  Hinweis statt des Albums.
- **Test:** –

### FOT-ALD-06 Link-Sichtbarkeit des Albums im Stapel

- **Wo:** im Freigabedialog „Alle mit bekannten Gesichtern freigeben“ und
  „Freigaben zurücknehmen“; in der Auswahlleiste „Über Freigabe-Link
  freigeben“, „Vom Freigabe-Link ausnehmen“, „Link-Sichtbarkeit
  automatisch“
- **Recht:** `photos.delete`
- **Vorbedingung:** keine
- **Schritte:**
  1. Aktion drücken.
- **Ergebnis:** Link-Badge auf den Kacheln; der Gast sieht nur
  freigegebene Fotos.
- **Fehler und Grenzfälle:** „Freigaben zurücknehmen“ setzt alle Fotos
  des Albums auf ausgenommen und fragt nach.
- **Test:** –

### FOT-ALD-07 Aus diesem Album entfernen

- **Wo:** „Aus diesem Album entfernen“ in der Auswahlleiste
- **Recht:** Besitzer oder Bearbeiter
- **Vorbedingung:** Auswahl
- **Schritte:**
  1. Aktion, Dialog „Aus Album entfernen“, bestätigen.
- **Ergebnis:** Fotos verschwinden aus dem Album, bleiben in der Galerie.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-ALD-08 Weitere Stapelaktionen

- **Wo:** Auswahlleiste: Collage, Fotobuch, Ablegen, Zu Alben hinzufügen,
  Beschreibung, Favorit, Ausblenden, Löschen
- **Recht:** wie in der Galerie
- **Vorbedingung:** Auswahl
- **Schritte:** wie `FOT-GAL-10` bis `FOT-GAL-17`
- **Ergebnis:** wie dort; „Fotobuch gestalten“ nimmt den Albumnamen als
  Titel vor.
- **Fehler und Grenzfälle:** Fremde Fotos im Album lassen sich nicht
  löschen; der Dialog „Einige Fotos wurden übersprungen“ nennt sie.
- **Test:** –

### FOT-ALD-09 Karte

- **Wo:** Umschalter Raster/Karte (nur mit „Karte aktivieren“)
- **Recht:** `photos.view`
- **Vorbedingung:** Fotos mit GPS
- **Schritte:**
  1. Karte wählen; Marker anklicken.
- **Ergebnis:** Vollbild des Fotos; Cluster zoomen auf.
- **Fehler und Grenzfälle:** Fotos ohne GPS fehlen auf der Karte; die
  Ergebniszahl nennt beide Zahlen.
- **Test:** –

### FOT-ALD-10 Cover fokussieren und Titelbild setzen

- **Wo:** „Cover fokussieren“ in `#actions`; Taste C im Vollbild
- **Recht:** Besitzer oder Bearbeiter
- **Vorbedingung:** Fotos im Album
- **Schritte:**
  1. „Cover fokussieren“ scrollt zum aktuellen Titelbild; C im Vollbild
     setzt das gezeigte Foto als Titelbild.
- **Ergebnis:** Kachel in `ALB` zeigt das neue Bild.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-ALD-11 Gruppen bearbeiten im Album

- **Wo:** „Gruppen bearbeiten (n offen)“
- **Recht:** `photos.delete`
- **Vorbedingung:** offene Gruppen im Album
- **Schritte:** wie `FOT-GAL-19`
- **Ergebnis:** wie dort; mit „Reviews der anderen übernehmen“ gelten
  Entscheidungen anderer Mitglieder auch für den eigenen Blick.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-ALD-12 Freigabe verlassen

- **Wo:** „Freigabe verlassen“ (nur in einem mit mir geteilten Album)
- **Recht:** geteilter Nutzer
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf, Dialog „Freigabe verlassen“, „Verlassen“.
- **Ergebnis:** Album verschwindet aus „Geteilt mit mir“, die Fotos aus
  der eigenen Galerie.
- **Fehler und Grenzfälle:** Der Besitzer kann erneut freigeben.
- **Test:** –

---

## GTA: Geteiltes Album (`/albums/shared/:token`)

Seite ohne Login für Gäste: Albumname, Raster oder Karte, Vollbild mit
Blättern und Diashow. Gäste können sich einen Gastnamen geben, um zu
reagieren und zu kommentieren; die Metadaten der Fotos sind bereinigt
(kein Ort, keine Personen).

### FOT-GTA-01 Album als Gast ansehen

- **Wo:** Link aus `FOT-ALD-05`
- **Recht:** keines
- **Vorbedingung:** gültiger Link
- **Schritte:**
  1. Link öffnen; Raster oder Karte wählen; Foto antippen.
- **Ergebnis:** Vollbild mit Pfeilen, Diashow, Download je Foto.
- **Fehler und Grenzfälle:** Abgelaufener oder gelöschter Link: Hinweis
  statt Album. Ausgenommene Fotos erscheinen nicht.
- **Test:** –

### FOT-GTA-02 Gastkonto anlegen und reagieren

- **Wo:** Knopf mit Personensymbol („Konto von …“), Reaktionen und
  Kommentarfeld im Vollbild
- **Recht:** keines
- **Vorbedingung:** keine
- **Schritte:**
  1. Namen eingeben; der Gast wird im Browser gemerkt.
  2. Reaktion setzen oder kommentieren.
- **Ergebnis:** Der Albumbesitzer sieht Reaktion und Kommentar unter
  Aktivität und in der Seitenleiste mit dem Gastnamen.
- **Fehler und Grenzfälle:** Ohne Namen sind Reaktionen gesperrt.
- **Test:** –

---

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| FOT-ALB-01 | Album anlegen | albums.manage | – |
| FOT-ALB-02 | Suchen, filtern, sortieren | view | – |
| FOT-ALB-03 | Album öffnen | view | – |
| FOT-ALB-04 | Album ablegen | view | – |
| FOT-ALD-01 | Fotos hochladen | upload + Album schreiben | – |
| FOT-ALD-02 | Album-Einstellungen | Album schreiben | – |
| FOT-ALD-03 | Album löschen | Besitzer | – |
| FOT-ALD-04 | Album an Nutzer freigeben | Besitzer / Teilen | – |
| FOT-ALD-05 | Öffentlichen Link erstellen | Besitzer / Teilen | – |
| FOT-ALD-06 | Link-Sichtbarkeit im Stapel | delete | – |
| FOT-ALD-07 | Aus diesem Album entfernen | Album schreiben | – |
| FOT-ALD-08 | Weitere Stapelaktionen | wie Galerie | – |
| FOT-ALD-09 | Karte | view | – |
| FOT-ALD-10 | Cover fokussieren, Titelbild | Album schreiben | – |
| FOT-ALD-11 | Gruppen bearbeiten im Album | delete | – |
| FOT-ALD-12 | Freigabe verlassen | geteilter Nutzer | – |
| FOT-GTA-01 | Album als Gast ansehen | – | – |
| FOT-GTA-02 | Gastkonto und reagieren | – | – |
