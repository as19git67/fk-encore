# Dokumenten-Ordner-Struktur & Gruppenkonzept (ehem. Haushalte)

Dieses Dokument beschreibt, wie hochgeladene Dokumente auf der Platte unter
`DOCUMENTS_DIR` abgelegt werden und wie Dokumente zwischen Einzelpersonen und
Gruppen (z. B. Familien oder Haushalts-Teilbereichen) geteilt werden können.

Status: implementiert in Migration `0036_documents_households`; die
Korrespondenten-Ebene (Abschnitt 3a) kam in Migration `0130`/`0131` dazu.

---

## 1. Ziele

- **Durchstöberbar im Dateisystem**: Ein Anwender soll auch ohne die Web-App
  auf einem File-Share direkt zur gesuchten Rechnung bzw. zum Bescheid
  navigieren können.
- **Sprechende Dateinamen**: `[YYYY_][#dokumentnummer_]<absender>_<titel>__<hash8>.pdf`
  statt opaker SHA-256-Shards.
- **Umzug bei Reklassifikation**: Ändert sich die Kategorie, das Datum, der
  Absender oder die Sichtbarkeit, wandert die Datei automatisch an ihren neuen
  kanonischen Platz.
- **Pro-Person-Isolation**: Private Dokumente eines Nutzers sind für andere
  nicht sichtbar — weder im UI noch im Dateisystem.
- **Gruppen-Pool**: Eine gemeinsame Gruppe (z. B. eine Familie oder nur die Eltern) kann eine
  gemeinsame Dokumentenablage verwenden, damit das Elternteil, das die Post aus
  dem Briefkasten geholt hat, nicht exklusiver Eigentümer der eingescannten
  Bescheide bleibt.
- **Steuer-Sicht per Hardlink**: Steuerrelevante Dokumente erscheinen zusätzlich
  unter `_steuer/<jahr>/<anlage>/` als Hardlink auf die kanonische Datei — ohne
  die Bytes zu verdoppeln.
- **Nach Korrespondent gruppiert**: Innerhalb einer Kategorie liegen alle
  Dokumente desselben Absenders (und, wo erkennbar, desselben Vertrags)
  zusammen in einem Ordner — statt nur nach Jahr verstreut. Siehe Abschnitt 3a.

---

## 2. Sichtbarkeitsmodell

Ein Dokument besitzt genau eine Sichtbarkeit:

| `visibility`  | `user_id`     | `group_id`     | Wer sieht es?                            |
|---------------|---------------|----------------|------------------------------------------|
| `private`     | Uploader      | `NULL`         | nur der Uploader                         |
| `group`       | Uploader      | Gruppen-ID     | jedes Mitglied dieser Gruppe             |

Der Uploader (`user_id`) bleibt in beiden Fällen erhalten — auch
Gruppendokumente "gehören" nominell der Person, die sie eingescannt hat.
Admin-Mutationen (Löschen, Sichtbarkeit umschalten) dürfen der Uploader *oder*
ein Gruppen-Owner — siehe `loadAdministrableDocument` in
`documents/visibility.ts`.

Die Datenbank setzt das Konsistenzregel als CHECK-Constraint durch:
`(visibility='private' AND group_id IS NULL) OR (visibility='group'
AND group_id IS NOT NULL)`.

Das Löschen einer Gruppe ist durch `ON DELETE RESTRICT` blockiert, solange
noch Dokumente daran hängen — damit niemand versehentlich Gruppendokumente
verwaist.

### Gruppen-Rollen

- `owner` — darf Mitglieder hinzufügen/entfernen, die Gruppe umbenennen,
  Dokumente anderer Mitglieder löschen.
- `member` — sieht alle Gruppendokumente, darf eigene hochladen, darf aber
  keine fremden Dokumente löschen.

---

## 3. Ordner-Schema

```
DOCUMENTS_DIR/
├── <user-login-slug>/                                  ← private Dokumente
│   ├── _inbox/YYYY-MM/                                 ← noch nicht klassifiziert
│   ├── <category-path>/<korrespondent>/*.pdf           ← klassifiziert
│   └── _steuer/<year>/<anlage>/*.pdf                   ← Hardlinks in Steuer-Sicht
└── _gruppe/<group-slug>/                            ← Gruppendokumente
    ├── _inbox/YYYY-MM/
    ├── <category-path>/<korrespondent>/*.pdf
    └── _steuer/<year>/<anlage>/*.pdf
```

`<korrespondent>` ist das in Abschnitt 3a beschriebene Ordner-Segment; die
`_steuer/`-Sicht bleibt bewusst nach Jahr/Anlage organisiert, ohne
Korrespondenten-Ebene.

Die kanonische Ablage besitzt keinen zusätzlichen Jahresordner. Das Jahr steht
bereits am Anfang des sprechenden Dateinamens; Dokumente verschiedener Jahre
liegen dadurch gemeinsam im Ordner ihres Korrespondenten und bleiben trotzdem
lexikografisch nach Jahr gruppiert.

Der `<user-login-slug>` wird aus dem Local-Part der E-Mail-Adresse abgeleitet
(`max.mueller@example.com` → `max-mueller`). Für rein numerische oder leere
Local-Parts fällt der Algorithmus auf `user-<id>` zurück.

Der `<group-slug>` wird beim Anlegen aus dem Gruppennamen erzeugt und
ist im Schema `UNIQUE`.

Das Dateinamens-Schema ist:

```
[YYYY_][#dokumentnummer_]<absender-slug>_<titel-slug>__<hash8>.pdf
```

Der Jahrespräfix stammt aus dem Dokumentdatum (`doc_date`). Wenn kein
Dokumentdatum vorhanden ist, entfällt der Jahrespräfix und stattdessen bleibt
das Upload-Datum `YYYY-MM-DD` als Fallback-Bestandteil im Dateinamen. Die
Dokumentnummer wird mit `#` vorangestellt, sofern sie vorhanden ist.

Beispiele:

- `2026_#2661160_finanzamt-muenchen_bescheid__a1b2c3d4.pdf`
- `2026_finanzamt-muenchen_bescheid__a1b2c3d4.pdf`
- `#2661160_2026-04-17_finanzamt-muenchen_bescheid__a1b2c3d4.pdf`

Fehlende Bestandteile entfallen (Dokument ohne Absender →
`2026_<titel>__<hash8>.pdf`). Das `__<hash8>`-Suffix sind die ersten 8
hex-Stellen des SHA-256 und garantiert Eindeutigkeit auch wenn zwei Dokumente
vom selben Absender im selben Jahr mit demselben Titel hochgeladen werden.

---

## 3a. Korrespondenten-Ebene

Der `sender`, den die KI-Klassifikation extrahiert, ist Freitext und für sich
genommen zu instabil, um als Ordnername zu dienen — "Janitos",
"Janitos Versicherung AG" und "Janitos AG" würden sonst drei verschiedene
Ordner erzeugen. Deshalb wird der Absender zuerst auf eine **stabile
Korrespondenten-Identität** abgebildet (`documents/correspondent.ts`), bevor
er in den Pfad einfließt.

### Aufbau des Ordner-Slugs

```
<absender>[-<produkt>][-<vertragsanker>]
```

- **`<absender>`** — kommt aus einer kuratierten Registry bekannter
  Institutionen (`documents/institutions.ts`, z. B. `janitos`, `comdirect`,
  `barmer`). Unbekannte Absender fallen auf einen slugifizierten Rohnamen
  zurück (Long-Tail, leichte Fragmentierung möglich — siehe Overrides unten).
- **`<produkt>`** — optional, aus einer Stichwort-Tabelle über den **Titel**
  des Dokuments (`privathaftpflicht`, `hausrat`, `kfz`, `leben`, …). Nur der
  Titel wird geprüft, damit beiläufige Erwähnungen im Fließtext kein Dokument
  in die falsche Produkt-Schublade stecken.
- **`<vertragsanker>`** — optional, aus den bereits vorhandenen
  Referenz-Tags `versicherungsnr:…` bzw. `vertragsnr:…`
  (`versicherungsnr` hat Vorrang). Wird angehängt, sobald vorhanden — damit
  mehrere Verträge desselben Anbieters und derselben Sparte nicht in einem
  Ordner landen (z. B. zwei Privathaftpflicht-Policen bei Janitos). Bewusst
  **nicht** `document_number`: dieses Feld ist pro Dokument, nicht pro
  Vertrag (siehe Issue #664 in `documents/metadata-extract.ts`).

Beispiele: `janitos-privathaftpflicht-4711884`, `janitos-hausrat`,
`comdirect` (nur Absender, kein Produkt/Vertrag erkannt). Ohne auflösbaren
Absender: das Platzhalter-Segment `_ohne-absender`.

### Persistierung

Die aufgelöste Identität (`correspondent_slug`, `correspondent_display`) wird
zusätzlich auf der `documents`-Zeile persistiert (Migration `0130`) — nicht
nur im Pfad. Geschrieben wird sie von `relocateDocument`, unabhängig davon, ob
die Datei tatsächlich verschoben wird. Das ermöglicht das Filtern/Gruppieren
"nach Korrespondent" in der Dokumentenliste, ohne den Absender bei jeder
Abfrage neu herzuleiten (`GET /documents/correspondents` für die Facette,
`?correspondent=<slug>` als Filter auf `GET /documents` und der Suche).

### Nutzer-Overrides

Passt die automatische Zuordnung nicht (z. B. soll ein unbekannter Absender
mit einem bestehenden Korrespondenten zusammengelegt werden, oder eine
Fehlzuordnung korrigiert werden), kann ein Nutzer in der Wartungsseite unter
„Korrespondenten-Overrides" ein Absender-Muster → Korrespondent-Mapping
anlegen (Migration `0131`, `documents/correspondent-overrides.ts`). Ein
Override schlägt die eingebaute Registry und greift, sobald das betroffene
Dokument neu abgelegt wird (Reklassifikation oder „Dateipfade
aktualisieren"). Treffen mehrere Muster, gewinnt immer das längste und damit
spezifischste Muster, unabhängig von der Reihenfolge in der Datenbank.
Overrides sind haushaltsweit (nicht pro Nutzer) und werden
mit kurzer TTL gecacht, damit der Massen-Umzug nicht pro Dokument nachfragt.

### Single Source der bekannten Institutionen

Die Korrespondenten-Registry wird aus `documents/institutions.ts` abgeleitet,
statt eine eigene Liste zu pflegen. `documents/institutions.test.ts` prüft,
dass jedes dort verwendete Absender-Fragment auch in den
Sender-Routing-Regeln (`documents/sender-rules.ts`) bekannt ist — die beiden
Listen können also nicht auseinanderlaufen, ohne dass ein Test fehlschlägt.

---

## 4. Lebenszyklus einer Datei

1. **Upload** (`POST /documents` oder Inbox-Watcher): Die Datei landet unter
   `<owner-root>/_inbox/<YYYY-MM>/<sha256>.pdf`. Die Sichtbarkeit ist
   zunächst `private` — das Hochschieben in eine Gruppe macht der Nutzer
   aktiv über das UI.
2. **Klassifikation** (Worker-Pipeline `text_extract → classify → embed`): Der
   `classify`-Job schreibt Kategorie, Datum, Absender, Titel und Steuerfelder
   in die DB. Danach ruft er `relocateDocument(id)` auf — das löst die
   Korrespondenten-Identität auf (Abschnitt 3a), verschiebt die Datei an
   ihren kanonischen Platz und baut die Steuer-Hardlinks auf.
3. **Nutzer-Korrektur** (`PATCH /documents/:id`): Das Ändern einer der Felder
   triggert erneut `relocateDocument`. Der Verschiebevorgang ist idempotent —
   steht die Datei bereits richtig, passiert nichts ausser einem Rebuild der
   Steuer-Links.
4. **Sichtbarkeits-Wechsel** (`POST /documents/:id/visibility`): Versetzt das
   Dokument zwischen privatem Bereich und Gruppenbereich; die Datei wandert
   in die entsprechende Owner-Root, alte Steuer-Hardlinks werden weggeräumt.
5. **Löschen** (`DELETE /documents/:id`): Entfernt die Steuer-Hardlinks zuerst,
   dann den DB-Eintrag (cascadet Tags + Tax-Zuordnungen), dann die kanonische
   Datei, und räumt leere Ordner nach oben hin auf.

`relocateDocument` ist in `documents/relocate.ts` implementiert. Es ist
cross-device-sicher (fällt bei EXDEV auf `copy+unlink` zurück) und path-traversal-
gesichert (`assertPathUnderDocumentsRoot` vor jeder fs-Operation).

---

## 5. Relevante Module

| `db/migrations/postgres/0036_…`   | Schema-Erweiterung: households (jetzt Gruppen)      |
| `db/migrations/postgres/0069_…`   | Umbenennung households -> groups                    |
| `db/migrations/postgres/0130_…`   | Persistierte Korrespondenten-Spalten auf `documents`     |
| `db/migrations/postgres/0131_…`   | Tabelle für Korrespondenten-Overrides                    |
| `documents/documents.service.ts`  | Path-Builder (`resolveDocumentDiskPath`, Slugifier, …)   |
| `documents/relocate.ts`           | Physische Umzüge + Steuer-Hardlink-Rebuild + Korrespondenten-Persistierung |
| `documents/correspondent.ts`      | Absender → Korrespondent (+ Produkt, Vertragsanker)      |
| `documents/institutions.ts`       | Registry bekannter Institutionen (Single Source, Abschnitt 3a) |
| `documents/correspondent-overrides.ts` | Laden/Cache der Nutzer-Overrides                    |
| `documents/visibility.ts`         | Zugriffskontrolle (`loadVisibleDocument`, …)             |
| `documents/groups.ts`             | API-Endpoints zum Verwalten von Gruppen                  |
| `documents/documents.ts`          | `POST /documents/:id/visibility`, Upload, CRUD, Suche, Korrespondenten-Facette + Override-CRUD |
| `documents/import.ts`             | Import-Logik für Dokumente                               |

---

## 6. Bestandsdateien aktualisieren

Vor Version 0036 hochgeladene Dokumente liegen unter dem alten
`YYYY/YYYY-MM/<sha256>.pdf`-Schema. Migration 0036 ändert nur das DB-Schema —
die Dateien wandern erst beim expliziten Aktualisieren der Dateipfade.

Die Wartungsseite bietet dafür neben „Nur KI-Klassifikation“ und
„OCR + Klassifikation“ die Aktion **Dateipfade aktualisieren**. Technisch ruft
sie `POST /documents/relocate-all` auf. Der Endpunkt benötigt `data.manage`,
iteriert alle Dokumente, ruft `relocateDocument` auf jedes einzelne auf und
meldet zurück, wie viele Dokumente geprüft, verschoben oder fehlgeschlagen sind.

`relocateDocument` ist idempotent: mehrfache Aufrufe sind gefahrlos.

Derselbe Mechanismus deckt auch die Einführung der Korrespondenten-Ebene
(Abschnitt 3a, Migration `0130`) ab: `relocateDocument` leitet Pfad und
Korrespondenten-Spalten immer frisch aus den aktuellen Metadaten ab, ein
einziger Klick auf **Dateipfade aktualisieren** genügt also, um den gesamten
Altbestand in die neue Ordnerstruktur zu überführen und die persistierten
Korrespondenten-Felder zu befüllen — ohne eigene Migrations-/Backfill-Logik.
Das gilt ebenso für das Entfernen der früheren Jahresordner-Ebene.
