# Fotos-Modul – Navigation und Persistenz

Dieses Dokument beschreibt, wie der aktuelle Zustand der Fotoansichten
(Galerie, Album, Personen, Albumliste) über Seitenwechsel hinweg erhalten
bleibt, was im Browser persistiert wird und wann diese Daten zurückgesetzt
werden.

---

## Überblick

Das Fotos-Modul besteht aus vier Hauptansichten, die eng miteinander
verzahnt sind:

| Route | Name | Komponente |
|---|---|---|
| `/fotos/galerie` | `fotos-gallery` | `GalleryView.vue` |
| `/fotos/alben` | `fotos-albums` | `AlbumsView.vue` |
| `/fotos/alben/:id` | `fotos-album` | `AlbumDetailView.vue` |
| `/fotos/personen` | `fotos-persons` | `PersonsView.vue` |

Das zentrale Bindeglied ist der **`photoNav` Pinia-Store**
(`stores/photoNav.ts`), der während der Browser-Session alle vier Ansichten
miteinander verbindet.

---

## Der `photoNav` Store

### Zustand

```typescript
selectedPhotoId:  number | null   // zuletzt betrachtetes Foto
selectedAlbumId:  number | null   // Album, aus dem das Foto stammt
jumpIntoAlbum:    boolean         // einmaliges Sprung-Flag (s. u.)
scrollPositions:  Record<string, number>  // Scroll-Offset je View-Key
```

### Persistenz

| Feld | Lebt in | Schlüssel | Überlebt Refresh? |
|---|---|---|---|
| `selectedPhotoId` | nur Pinia (RAM) | – | ✗ |
| `selectedAlbumId` | Pinia + localStorage | `albums_last_focused_album_id` | ✓ |
| `jumpIntoAlbum` | nur Pinia (RAM) | – | ✗ |
| `scrollPositions` | nur Pinia (RAM) | – | ✗ |

`selectedPhotoId` überlebt keinen Refresh — die Galerie liest beim Start
stattdessen den **separaten** `localStorage`-Schlüssel `photos_last_selected_id`,
der von `GalleryView` nach jeder Hydration (Cursorbewegung) geschrieben wird.

`selectedAlbumId` und `albums_last_focused_album_id` sind bewusst identisch
mit dem Schlüssel, den `rememberFocusedAlbumId()` / `readRememberedAlbumId()`
aus `utils/albumsViewState.ts` nutzen. Damit müssen `AlbumsView` und der
Store denselben Wert nicht doppelt führen.

### Methoden

| Methode | Wer ruft sie | Wirkung |
|---|---|---|
| `selectPhoto(id)` | GalleryView, PersonsView | setzt `selectedPhotoId`, löscht `scrollPositions` |
| `selectPhotoInAlbum(photoId, albumId)` | AlbumDetailView | setzt beide IDs, schreibt `albumId` in localStorage, setzt `jumpIntoAlbum = true` |
| `consumeAlbumJump()` | AlbumsView (onMounted) | gibt aktuellen Wert zurück, setzt Flag auf `false` |
| `saveScrollPosition(key, px)` | (reserviert) | speichert Scroll-Offset für spätere Nutzung |
| `getScrollPosition(key)` | (reserviert) | liest gespeicherten Offset |

---

## Persistenzschichten im Überblick

### 1. `localStorage` (seitenübergreifend persistent)

| Schlüssel | Wert | Geschrieben von | Gelesen von |
|---|---|---|---|
| `photos_last_selected_id` | letzte Foto-ID | `GalleryView.hydrateCursor()` | `GalleryView` (onMounted) |
| `albums_last_focused_album_id` | letzte Album-ID | `rememberFocusedAlbumId()`, `photoNav.selectPhotoInAlbum()` | `AlbumsView` (`readRememberedAlbumId()`), `photoNav` Store (Init) |
| `albums_last_photo_by_album` | Map `albumId → photoId` | `AlbumDetailView.saveLastPhotoForAlbum()` | `AlbumDetailView.loadData()` |
| `albums_view_state` | Filter/Sortierung/Suche | `AlbumsView.saveAlbumsStateToStorage()` | `AlbumsView` (onMounted), `AlbumDetailView.navigateBackToAlbums()` |

### 2. Pinia (RAM, wird bei Refresh zurückgesetzt)

- `selectedPhotoId` — aktuelle Foto-ID in der Session
- `selectedAlbumId` — wird bei Init aus localStorage gefüllt, ist danach immer aktuell
- `jumpIntoAlbum` — einmaliges Flag zwischen AlbumDetailView und AlbumsView
- `scrollPositions` — nicht aktiv genutzt (reserviert)

### 3. URL-Query-Parameter (tief verlinkbar)

| Parameter | Ansicht | Verhalten |
|---|---|---|
| `?photoId=<id>` | GalleryView | öffnet das Foto direkt in der Vollbildansicht |
| `?photoId=<id>` | AlbumDetailView | selektiert und scrollt zum Foto; öffnet TripMap-Stop wenn Album im Kartenmodus ist |
| `?q`, `?owner`, `?sortBy`, … | AlbumsView | stellt Filter/Sortierung wieder her (für Deep-Links und Tab-Sync) |

URL-Parameter werden nach dem Einlesen sofort per `router.replace()` entfernt,
damit die URL sauber bleibt.

---

## Navigationsflüsse

### Galerie → Galerie (selbes Tab, andere Filter)

`VirtualGallery` reagiert auf Änderungen an Filter/Sortierung/Suche mit einem
kompletten Reload (`source.init()`). Das `initialAnchor`-Prop (Foto-ID) wirkt
nur beim ersten Mount — danach gilt nur der neue Anker `null` (Fensteranfang
der neuen Abfrage).

### Album → Foto auswählen → Galerie

1. `AlbumDetailView.watch(selectedPhoto)` ruft `photoNav.selectPhotoInAlbum(photoId, albumId)` auf.
2. Der Store setzt `selectedPhotoId`, `selectedAlbumId`, `jumpIntoAlbum = true` und schreibt `albumId` in localStorage.
3. Der Nutzer navigiert über das Hauptmenü zur Galerie.
4. `GalleryView` liest beim Mount: Priorität 1) `?photoId=` — nicht gesetzt; Priorität 2) `photoNav.selectedPhotoId` — gesetzt → `initialAnchor = photoId`.
5. `VirtualGallery` lädt ein Fenster um das Foto (`aroundPhotoId`), findet dessen genauen Index via `findLoadedIndexById()` und scrollt direkt dorthin.
6. `onGalleryLoaded` setzt zusätzlich `cursorIndex` und ruft `hydrateCursor()` auf, so dass die Desktop-Sidebar das Foto sofort anzeigt.

### Galerie → Albums (erster Besuch nach Album-Auswahl)

`AlbumsView.onMounted()` prüft `photoNav.consumeAlbumJump()`:
- **true**: navigiert sofort nach `/fotos/alben/<albumId>` (kein `loadData()`), ruft vorher `rememberFocusedAlbumId(albumId)` auf.
- **false**: normaler `loadData()`-Pfad, Album wird in der Liste hervorgehoben.

Im Album angekommen, liest `AlbumDetailView.loadData()` die Foto-ID aus der
Fallback-Kette:
1. `?photoId=` Query-Parameter (nicht gesetzt)
2. `loadLastPhotoMap()[albumId]` (in localStorage gespeichert)
3. `photoNav.selectedPhotoId` (in RAM)

Das Foto wird selektiert und gescrollt.

### Galerie → Albums (weiterer Besuch ohne neue Album-Auswahl)

`jumpIntoAlbum` ist `false` (wurde beim ersten Besuch konsumiert).
`AlbumsView` lädt die Albumliste normal. `rememberedAlbumId` ist aus
`readRememberedAlbumId()` (localStorage) oder — als Fallback — aus
`photoNav.selectedAlbumId` (RAM) bekannt.
`VirtualAlbumGrid` scrollt und hebt das Album hervor.

### Album → Zurück zur Albumliste

`AlbumDetailView.navigateBackToAlbums()` ruft `rememberFocusedAlbumId(albumId.value)`
auf (schreibt in localStorage) und navigiert zu `/fotos/alben` mit den
wiederhergestellten Filter/Sort-Query-Params. `AlbumsView` liest
`rememberedAlbumId` beim Mount aus localStorage und gibt sie an
`VirtualAlbumGrid` weiter.

### Personen → Foto auswählen → Galerie

`PersonsView` ruft `photoNav.selectPhoto(photo.id)` auf (ohne Album-Kontext).
Die Galerie verwendet `selectedPhotoId` als `initialAnchor` — identischer
Ablauf wie der Album-zu-Galerie-Pfad, nur ohne `jumpIntoAlbum`.

---

## Wann wird was zurückgesetzt?

| Ereignis | Was wird zurückgesetzt |
|---|---|
| Nutzer wählt ein neues Foto | `scrollPositions` wird geleert (alle Views scrollen zur neuen Auswahl) |
| `jumpIntoAlbum` wird konsumiert | Flag wird auf `false` gesetzt (einmalig) |
| Browser-Refresh | `selectedPhotoId`, `jumpIntoAlbum`, `scrollPositions` gehen verloren; `selectedAlbumId` bleibt (localStorage) |
| Nutzer löscht localStorage | Alle Persistenzwerte weg; App startet ohne Vorauswahl |
| Filter/Sortierung ändert sich | `VirtualGallery` führt Reload durch, scrollt zum Anfang der neuen Ergebnisse |

---

## Zusammenspiel der Komponenten (schematisch)

```
AlbumDetailView
  watch(selectedPhoto)
    └─► photoNav.selectPhotoInAlbum(photoId, albumId)
          ├─ selectedPhotoId = photoId         (RAM)
          ├─ selectedAlbumId = albumId         (RAM + localStorage)
          └─ jumpIntoAlbum   = true            (RAM)

  saveLastPhotoForAlbum(albumId, photoId)
    └─► localStorage["albums_last_photo_by_album"][albumId] = photoId

GalleryView (onMounted)
  initialAnchor = photoNav.selectedPhotoId    (RAM)  ← nach Album-Auswahl
               ?? localStorage["photos_last_selected_id"]  ← nach Refresh
  VirtualGallery(:around-photo-id="initialAnchor")
    └─► loadAndScroll(anchor)
          ├─ source.init(aroundPhotoId)       ← Fenster vom Server laden
          ├─ findLoadedIndexById(anchor)       ← exakten Index suchen
          └─ virtualizer.scrollToIndex(row)   ← dorthin scrollen
  onGalleryLoaded()
    └─► hydrateCursor(idx) → photoNav.selectPhoto(id)
                           → localStorage["photos_last_selected_id"] = id

AlbumsView (onMounted)
  if photoNav.consumeAlbumJump() && selectedAlbumId
    ├─ rememberFocusedAlbumId(selectedAlbumId)
    └─► router.push("/fotos/alben/<albumId>")   ← direkt ins Album
  else
    ├─ loadData()
    └─ rememberedAlbumId = readRememberedAlbumId()   (localStorage)
                        ?? photoNav.selectedAlbumId  (RAM, Fallback)
       └─► VirtualAlbumGrid(:rememberedAlbumId)      ← Album hervorheben
```

---

## Betroffene Dateien

| Datei | Rolle |
|---|---|
| `frontend/src/stores/photoNav.ts` | Zentraler Store für Foto-/Album-Selektion |
| `frontend/src/utils/albumsViewState.ts` | localStorage-Helpers für Album-Filter, -Sortierung und fokussiertes Album |
| `frontend/src/views/GalleryView.vue` | Liest `initialAnchor`, schreibt `photos_last_selected_id` |
| `frontend/src/views/AlbumDetailView.vue` | Ruft `selectPhotoInAlbum`, liest `loadLastPhotoMap` |
| `frontend/src/views/AlbumsView.vue` | Konsumiert `jumpIntoAlbum`, liest `rememberedAlbumId` |
| `frontend/src/views/PersonsView.vue` | Ruft `selectPhoto` |
| `frontend/src/components/VirtualGallery.vue` | `loadAndScroll`: Foto-genaues Scrollen via `findLoadedIndexById` |
| `frontend/src/composables/useGallerySource.ts` | `source.init(aroundPhotoId)`: Backend-Fenster um das Ankerfoto |
