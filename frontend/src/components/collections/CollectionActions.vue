<script setup lang="ts">
/**
 * What can be done to a Sammelmappe from a list — one menu and its dialogs,
 * the same wherever folders are listed (the Sammelmappen page, the document
 * list, Dokumente › Sammelmappen). The list opens the menu for a folder with
 * `openMenu(event, collection)` and the star with `toggleFavourite`; after
 * anything that changes the list it emits `changed`, so the list reloads.
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Menu from 'primevue/menu'
import ExportDialog from './ExportDialog.vue'
import ShareLinkDialog from './ShareLinkDialog.vue'
import {
  applyCollectionRuleNow,
  createAlbumFromCollection,
  deleteAnyCollection,
  setCollectionRule,
  updateAnyCollection,
  type CollectionSummary,
} from '../../api/collections'

const emit = defineEmits<{
  changed: []
  error: [message: string]
  notice: [message: string]
}>()

const router = useRouter()
const confirm = useConfirm()

function fail(err: unknown, fallback: string) {
  emit('error', err instanceof Error ? err.message : fallback)
}

async function toggleFavourite(c: CollectionSummary) {
  const next = !c.favourite
  c.favourite = next
  try {
    await updateAnyCollection(c.id, { favourite: next })
  } catch (err: unknown) {
    c.favourite = !next
    fail(err, 'Speichern fehlgeschlagen.')
  }
}

async function setArchived(c: CollectionSummary, value: boolean) {
  try {
    await updateAnyCollection(c.id, { archived: value })
    emit('changed')
  } catch (err: unknown) {
    fail(err, 'Speichern fehlgeschlagen.')
  }
}

function askDelete(c: CollectionSummary) {
  confirm.require({
    header: 'Sammelmappe löschen?',
    message: `„${c.name}“ wird gelöscht. Was darin liegt, bleibt erhalten.`,
    icon: 'pi pi-exclamation-triangle',
    acceptLabel: 'Löschen',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: () => {
      void deleteAnyCollection(c.id)
        .then(() => emit('changed'))
        .catch((err: unknown) => fail(err, 'Löschen fehlgeschlagen.'))
    },
  })
}

const renameTarget = ref<CollectionSummary | null>(null)
const renameValue = ref('')
function openRename(c: CollectionSummary) {
  renameTarget.value = c
  renameValue.value = c.name
}
async function saveRename() {
  const c = renameTarget.value
  const name = renameValue.value.trim()
  if (!c || !name) return
  try {
    await updateAnyCollection(c.id, { name })
    renameTarget.value = null
    emit('changed')
  } catch (err: unknown) {
    fail(err, 'Umbenennen fehlgeschlagen.')
  }
}

const exportTarget = ref<CollectionSummary | null>(null)
const exportOpen = computed({
  get: () => exportTarget.value !== null,
  set: (open: boolean) => {
    if (!open) exportTarget.value = null
  },
})

const shareTarget = ref<CollectionSummary | null>(null)
const shareOpen = computed({
  get: () => shareTarget.value !== null,
  set: (open: boolean) => {
    if (!open) shareTarget.value = null
  },
})

async function applyRule(c: CollectionSummary) {
  try {
    const { applied } = await applyCollectionRuleNow(c.id)
    emit('notice', `„${c.name}“: ${applied.added} neu, ${applied.removed} entfernt.`)
    emit('changed')
  } catch (err: unknown) {
    fail(err, 'Regel konnte nicht angewendet werden.')
  }
}

function askStopRule(c: CollectionSummary) {
  confirm.require({
    header: 'Regel beenden?',
    message: `„${c.name}“ behält, was darin liegt, füllt sich aber nicht mehr von selbst.`,
    icon: 'pi pi-question-circle',
    acceptLabel: 'Regel beenden',
    rejectLabel: 'Abbrechen',
    accept: () => {
      void setCollectionRule(c.id, null)
        .then(() => emit('changed'))
        .catch((err: unknown) => fail(err, 'Speichern fehlgeschlagen.'))
    },
  })
}

const albumSource = ref<CollectionSummary | null>(null)
const albumName = ref('')
function openAlbumFrom(c: CollectionSummary) {
  albumSource.value = c
  albumName.value = c.name
}
async function createAlbum() {
  const c = albumSource.value
  const name = albumName.value.trim()
  if (!c || !name) return
  try {
    const res = await createAlbumFromCollection(c.id, name)
    albumSource.value = null
    void router.push({ name: 'fotos-album-detail', params: { id: res.album_id } })
  } catch (err: unknown) {
    fail(err, 'Album konnte nicht erstellt werden.')
  }
}

// One menu for the whole list, filled for the folder that opened it.
const menu = ref<InstanceType<typeof Menu> | null>(null)
const menuItems = ref<Array<{ label: string; icon: string; command: () => void }>>([])
function openMenu(event: Event, c: CollectionSummary) {
  const entries: Array<{ label: string; icon: string; command: () => void }> = [
    { label: 'Umbenennen', icon: 'pi pi-pencil', command: () => openRename(c) },
    { label: 'Exportieren', icon: 'pi pi-download', command: () => (exportTarget.value = c) },
  ]
  if (c.kind === 'rule') {
    entries.push(
      { label: 'Regel jetzt anwenden', icon: 'pi pi-sync', command: () => void applyRule(c) },
      { label: 'Regel beenden', icon: 'pi pi-ban', command: () => askStopRule(c) },
    )
  }
  if ((c.counts.photo ?? 0) > 0) {
    entries.push({ label: 'Album daraus erstellen', icon: 'pi pi-book', command: () => openAlbumFrom(c) })
  }
  if (c.can_administer) {
    entries.push(
      { label: 'Freigabelink', icon: 'pi pi-globe', command: () => (shareTarget.value = c) },
      c.archived_at
        ? { label: 'Zurückholen', icon: 'pi pi-replay', command: () => void setArchived(c, false) }
        : { label: 'Archivieren', icon: 'pi pi-box', command: () => void setArchived(c, true) },
      { label: 'Löschen', icon: 'pi pi-trash', command: () => askDelete(c) },
    )
  }
  menuItems.value = entries
  menu.value?.toggle(event)
}

defineExpose({ openMenu, toggleFavourite })
</script>

<template>
  <Menu ref="menu" :model="menuItems" popup />

  <Dialog
    class="dialog-sm"
    :visible="renameTarget !== null"
    modal
    header="Sammelmappe umbenennen"
    @update:visible="(v: boolean) => { if (!v) renameTarget = null }"
  >
    <InputText v-model="renameValue" autofocus class="ca-input" aria-label="Neuer Name" @keyup.enter="saveRename" />
    <template #footer>
      <Button label="Abbrechen" severity="secondary" text @click="renameTarget = null" />
      <Button label="Speichern" icon="pi pi-check" :disabled="!renameValue.trim()" @click="saveRename" />
    </template>
  </Dialog>

  <Dialog
    class="dialog-sm"
    :visible="albumSource !== null"
    modal
    header="Album aus Sammelmappe"
    @update:visible="(v: boolean) => { if (!v) albumSource = null }"
  >
    <p class="ca-note">Die Fotos der Mappe kommen in ein neues Album. Die Mappe bleibt, wie sie ist.</p>
    <label class="ca-field">
      <span>Name des Albums</span>
      <InputText v-model="albumName" autofocus class="ca-input" @keyup.enter="createAlbum" />
    </label>
    <template #footer>
      <Button label="Abbrechen" severity="secondary" text @click="albumSource = null" />
      <Button label="Album erstellen" icon="pi pi-book" :disabled="!albumName.trim()" @click="createAlbum" />
    </template>
  </Dialog>

  <ExportDialog v-model:visible="exportOpen" :collection-id="exportTarget?.id ?? null" :name="exportTarget?.name ?? ''" />
  <ShareLinkDialog v-model:visible="shareOpen" :collection-id="shareTarget?.id ?? null" :name="shareTarget?.name ?? ''" />
</template>

<style scoped>
.ca-input {
  width: 100%;
}
.ca-note {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.ca-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
</style>
