import { ref, type Ref } from 'vue'
import { listAlbums, listPersons, type Album, type Person } from '../api/photos'

/**
 * App-weiter Cache für die Listen, die mehrere Galerie-Komponenten parallel
 * anfordern (Sidebar, FilterMenu, FilterChips, PhotosView). Ohne diesen Cache
 * feuert jede Komponente ihren eigenen Request — die Backend-Queries sind
 * teuer (bis zu 12 s für /persons), und doppelte Aufrufe blockieren die UI
 * sichtbar.
 *
 * Drei Garantien:
 *  1. Parallele Aufrufer teilen sich denselben in-flight Promise.
 *  2. Erfolgreich geladene Daten werden in module-scoped Refs gehalten und
 *     bei jedem Wiedereinstieg sofort aus dem Cache geliefert.
 *  3. Mutationen (Anlegen/Umbenennen/Löschen von Person/Album) rufen
 *     `invalidatePersons()` / `invalidateAlbums()` auf, damit der nächste
 *     Reader die Liste frisch lädt.
 */

const persons = ref<Person[]>([])
const personsLoaded = ref(false)
let personsInFlight: Promise<Person[]> | null = null

const albums = ref<Album[]>([])
const albumsLoaded = ref(false)
let albumsInFlight: Promise<Album[]> | null = null

async function fetchPersons(force = false): Promise<Person[]> {
  if (!force && personsLoaded.value) return persons.value
  if (personsInFlight) return personsInFlight
  personsInFlight = (async () => {
    try {
      const res = await listPersons()
      persons.value = res.persons
      personsLoaded.value = true
      return res.persons
    } finally {
      personsInFlight = null
    }
  })()
  return personsInFlight
}

async function fetchAlbums(force = false): Promise<Album[]> {
  if (!force && albumsLoaded.value) return albums.value
  if (albumsInFlight) return albumsInFlight
  albumsInFlight = (async () => {
    try {
      const res = await listAlbums()
      albums.value = res.albums
      albumsLoaded.value = true
      return res.albums
    } finally {
      albumsInFlight = null
    }
  })()
  return albumsInFlight
}

function invalidatePersons() {
  personsLoaded.value = false
}

function invalidateAlbums() {
  albumsLoaded.value = false
}

export interface UseReferenceData {
  persons: Ref<Person[]>
  albums: Ref<Album[]>
  personsLoaded: Ref<boolean>
  albumsLoaded: Ref<boolean>
  fetchPersons: (force?: boolean) => Promise<Person[]>
  fetchAlbums: (force?: boolean) => Promise<Album[]>
  invalidatePersons: () => void
  invalidateAlbums: () => void
}

export function useReferenceData(): UseReferenceData {
  return {
    persons,
    albums,
    personsLoaded,
    albumsLoaded,
    fetchPersons,
    fetchAlbums,
    invalidatePersons,
    invalidateAlbums,
  }
}
