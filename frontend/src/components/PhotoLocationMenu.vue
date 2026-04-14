<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Menu from 'primevue/menu'
import type { MenuItem } from 'primevue/menuitem'
import { getPhotoLocations } from '../api/photos'

const props = defineProps<{
  /** ID of the photo whose jump destinations should be shown. */
  photoId: number
  /** When true, hide the "Alle Fotos" option (we're already there). */
  excludeAllPhotos?: boolean
  /** Hide the entry for this album (we're already viewing it). */
  excludeAlbumId?: number
  /** Hide the entry for this person (we're already viewing it). */
  excludePersonId?: number
  /** Button severity / style. */
  severity?: 'secondary' | 'primary' | 'info'
  /** Show label next to the icon (default: icon only). */
  showLabel?: boolean
  /** Button size. */
  size?: 'small' | 'large'
  /** When true, render as a plain/rounded icon-only button (default). */
  iconOnly?: boolean
}>()

const router = useRouter()
const menu = ref<InstanceType<typeof Menu> | null>(null)
const loading = ref(false)
const items = ref<MenuItem[]>([])

/** Build a Vue Router destination for a jump target. */
function goToAllPhotos() {
  router.push({ name: 'fotos-gallery', query: { photoId: String(props.photoId) } })
}
function goToAlbum(albumId: number) {
  router.push({ name: 'fotos-album-detail', params: { id: String(albumId) }, query: { photoId: String(props.photoId) } })
}
function goToPerson(personId: number) {
  router.push({ name: 'fotos-people', query: { personId: String(personId), photoId: String(props.photoId) } })
}

async function handleClick(event: MouseEvent) {
  if (loading.value) return
  loading.value = true
  try {
    const locations = await getPhotoLocations(props.photoId)

    // Build destination list, filtering out the current context.
    const destinations: Array<
      | { kind: 'all-photos' }
      | { kind: 'album'; id: number; name: string }
      | { kind: 'person'; id: number; name: string }
    > = []

    if (!props.excludeAllPhotos) {
      destinations.push({ kind: 'all-photos' })
    }
    for (const a of locations.albums) {
      if (props.excludeAlbumId === a.id) continue
      destinations.push({ kind: 'album', id: a.id, name: a.name })
    }
    for (const p of locations.persons) {
      if (props.excludePersonId === p.id) continue
      destinations.push({ kind: 'person', id: p.id, name: p.name })
    }

    if (destinations.length === 0) {
      // No jump target available — show an empty menu entry for feedback.
      items.value = [{ label: 'Keine weiteren Fundorte', disabled: true }]
      menu.value?.toggle(event)
      return
    }

    if (destinations.length === 1) {
      const only = destinations[0]!
      if (only.kind === 'all-photos') goToAllPhotos()
      else if (only.kind === 'album') goToAlbum(only.id)
      else goToPerson(only.id)
      return
    }

    // Build PrimeVue menu items (grouped: Galerie, Alben, Personen).
    const built: MenuItem[] = []
    const allPhotos = destinations.find(d => d.kind === 'all-photos')
    if (allPhotos) {
      built.push({
        label: 'Alle Fotos',
        icon: 'pi pi-images',
        command: () => goToAllPhotos(),
      })
    }
    const albumDests = destinations.filter(d => d.kind === 'album') as Array<{ kind: 'album'; id: number; name: string }>
    if (albumDests.length > 0) {
      built.push({ separator: true })
      built.push({ label: 'Alben', class: 'loc-menu-header', disabled: true })
      for (const a of albumDests) {
        built.push({
          label: a.name,
          icon: 'pi pi-book',
          command: () => goToAlbum(a.id),
        })
      }
    }
    const personDests = destinations.filter(d => d.kind === 'person') as Array<{ kind: 'person'; id: number; name: string }>
    if (personDests.length > 0) {
      built.push({ separator: true })
      built.push({ label: 'Personen', class: 'loc-menu-header', disabled: true })
      for (const p of personDests) {
        built.push({
          label: p.name,
          icon: 'pi pi-user',
          command: () => goToPerson(p.id),
        })
      }
    }

    items.value = built
    menu.value?.toggle(event)
  } catch (err) {
    console.error('Failed to load photo locations:', err)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <span class="photo-location-menu">
    <Button
      :icon="loading ? 'pi pi-spin pi-spinner' : 'pi pi-external-link'"
      :label="showLabel ? 'Anzeigen in…' : undefined"
      :severity="severity ?? 'secondary'"
      :size="size"
      :text="iconOnly !== false"
      :rounded="iconOnly !== false"
      :disabled="loading"
      v-tooltip.bottom="'Foto anzeigen in\u2026'"
      aria-label="Foto anzeigen in…"
      @click="handleClick"
    />
    <Menu ref="menu" :model="items" :popup="true" />
  </span>
</template>

<style scoped>
.photo-location-menu { display: inline-flex; }
:global(.p-menu .loc-menu-header) {
  font-size: 0.75em;
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding-top: 0.25em;
}
:global(.p-menu .loc-menu-header .p-menuitem-link) { cursor: default; }
</style>
