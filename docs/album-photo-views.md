# Album Photo Views - Feature-Dokumentation

## Hintergrund und Motivation

In geteilten Fotoalben gibt es ein wiederkehrendes Problem: Mehrere Personen steuern Fotos bei, aber beim Aussortieren gibt es unterschiedliche Meinungen. Ein Teilnehmer wuerde ein Foto loeschen, der andere nicht. Selbst nach dem Aussortieren bleiben oft noch zu viele Bilder uebrig, um schnell die Highlights eines Ereignisses zeigen zu koennen.

### Kernprobleme

1. **Meinungsverschiedenheiten beim Aussortieren** - Es gibt keinen objektiven "richtigen" Schnitt fuer ein Album
2. **Zu viele Fotos nach dem Aussortieren** - 200+ Fotos sind fuer eine schnelle Praesentation immer noch zu viel
3. **Keine Sichtbarkeit der Meinungen anderer** - Man weiss nicht, was andere Teilnehmer fuer gut oder schlecht halten

## Loesung: Views mit anonymisierten Meinungen

Statt sich auf *einen* Schnitt einigen zu muessen, sieht jeder Teilnehmer *seine* Version des Albums. Die Meinungen der anderen sind als anonymisierte Zaehler sichtbar ("3 von 5 finden's gut"), ohne zu verraten, wer genau was entschieden hat.

### Design-Entscheidungen

- **Anonymisiert statt namentlich**: Soziale Dynamik wird vermieden. Man sieht "2 von 4 haben ausgeblendet", nicht "Max hat dein Foto ausgeblendet"
- **Preset-basiert statt komplex**: 3 vordefinierte Views decken 90% der Use Cases ab
- **Progressive Komplexitaet**: Basis-Mechanik (Ausblenden/Favorisieren) existierte bereits. Views sind eine neue Linse auf bestehende Daten
- **KI als dritte Stimme**: Der AI-Quality-Score gibt eine neutrale, technische Bewertung neben den menschlichen Meinungen

## Architektur

### Datenmodell

Das Feature baut vollstaendig auf bestehenden Tabellen auf:

- **`photo_curation`** (bestehend): Speichert pro User+Photo den Status (`visible` | `hidden` | `favorite`)
- **`album_user_settings`** (erweitert): `active_view` um neue Werte erweitert, `view_config` JSONB jetzt typisiert

Keine neuen Tabellen noetig.

### Neue Typen

```typescript
type ActiveView = "all" | "favorites" | "consensus" | "custom";

interface ViewConfig {
  hideFilter: "none" | "mine" | "consensus";
  hideConsensusMin?: number;
  favFilter: "all" | "mine" | "any" | "consensus";
  favConsensusMin?: number;
}

interface PhotoCurationStats {
  fav_count: number;    // Wie viele Album-Teilnehmer favorisiert haben
  hide_count: number;   // Wie viele ausgeblendet haben
  member_count: number; // Gesamtzahl Teilnehmer
}
```

### View-Presets

| Preset | hideFilter | favFilter | Beschreibung |
|---|---|---|---|
| **Alle Fotos** | `mine` | `all` | Standard - alles ausser meine ausgeblendeten |
| **Meine Favoriten** | `mine` | `mine` | Nur was ich favorisiert habe |
| **Gruppen-Highlights** | `consensus` (min 1) | `consensus` (min 2) | Was mindestens 2 Leute gut finden und keiner ausgeblendet hat |

### Query-Logik

Die Album-Foto-Abfrage aggregiert Curation-Daten ueber alle Teilnehmer:

```sql
SELECT p.*, my_pc.status AS curation_status,
  SUM(CASE WHEN all_pc.status = 'favorite' THEN 1 ELSE 0 END) AS fav_count,
  SUM(CASE WHEN all_pc.status = 'hidden' THEN 1 ELSE 0 END) AS hide_count
FROM photos p
INNER JOIN album_photos ap ON ap.photo_id = p.id
LEFT JOIN photo_curation my_pc ON my_pc.photo_id = p.id AND my_pc.user_id = :userId
LEFT JOIN photo_curation all_pc ON all_pc.photo_id = p.id
  AND all_pc.user_id = ANY(:participantIds)
GROUP BY p.id, my_pc.status
```

Filter werden in JavaScript angewendet (statt dynamische HAVING-Klauseln), da die Foto-Anzahl pro Album typischerweise handhabbar ist und der Code deutlich lesbarer bleibt.

### Performance

- Neuer Index: `idx_photo_curation_photo_status` auf `photo_curation(photo_id, status)` fuer schnelle Aggregation
- Teilnehmer-IDs werden einmal abgefragt und im Array uebergeben statt Subquery pro Foto

## Frontend-Integration

### View-Auswahl

Die bisherigen zwei getrennten SelectButtons (Ansicht + Ausblenden) wurden durch eine einzige View-Auswahl mit Presets ersetzt. Der "Gruppen-Highlights" Button erscheint nur bei geteilten Alben.

### Anonymisierte Badges im Foto-Grid

Jedes Foto in geteilten Alben zeigt kleine Badges:
- Herz-Icon mit Zaehler (z.B. "3/5") - Favoriten-Zaehler
- Augen-Icon mit Zaehler (z.B. "1/5") - Ausblend-Zaehler (nur wenn > 0)

### Meinungen-Block in der Detail-Sidebar

Bei Auswahl eines Fotos im geteilten Album zeigt die Sidebar einen "Meinungen"-Block mit:
- Fortschrittsbalken fuer Favoriten-Anteil
- Fortschrittsbalken fuer Ausblend-Anteil (nur wenn > 0)
- KI-Bewertung als dritte Reihe (wenn vorhanden)

## Betroffene Dateien

### Backend
- `db/types.ts` - Neue Typen (ViewConfig, ActiveView, PhotoCurationStats)
- `db/schema.ts` - Unveraendert (JSONB view_config traegt die neuen Typen)
- `db/migrations/postgres/0010_album_curation_views.sql` - Performance-Index
- `photo/photo.service.ts` - Aggregierte Query, Preset-Mapping, Filter-Logik

### Frontend
- `frontend/src/api/photos.ts` - Neue Typen (AlbumPhoto, ViewConfig, PhotoCurationStats)
- `frontend/src/views/AlbumDetailView.vue` - Vereinheitlichte View-Auswahl
- `frontend/src/components/PhotoGrid.vue` - Curation-Stats-Badges
- `frontend/src/components/PhotoDetailSidebar.vue` - Meinungen-Block mit Fortschrittsbalken

## Moegliche Erweiterungen (Zukunft)

1. **Custom-View-Dialog**: Wenn "Benutzerdefiniert" gewaehlt, ein Panel mit Slidern fuer consensus-Schwellwerte
2. **Gespeicherte/benannte Views**: Pro User pro Album mehrere Views speichern ("Fotobuch-Auswahl", "Fuer Oma")
3. **Geteilte Views**: Ein User erstellt eine View und teilt sie mit anderen
4. **View als Export-Basis**: "Exportiere diese View als ZIP"
5. **Automatische AI-Views**: "Top 20% nach KI-Qualitaet"
