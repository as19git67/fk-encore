<script setup lang="ts">
/**
 * Anonymous share links of a collection (#1548, stage 8).
 *
 * A link shows the collection as it is at the moment it is opened — its
 * photos (without place and camera data), albums and whole documents —
 * to anyone who has it, until it expires or is ended here. Bookings,
 * securities and meters never go out.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import Select from 'primevue/select'
import {
  createCollectionPublicLink,
  disableCollectionPublicLink,
  listCollectionPublicLinks,
  type CollectionPublicLink,
  type LinkExpiry,
} from '../../api/collections'

const props = defineProps<{ visible: boolean; collectionId: number | null; name: string }>()
const emit = defineEmits<{ (e: 'update:visible', value: boolean): void }>()

const router = useRouter()
const confirm = useConfirm()
const links = ref<CollectionPublicLink[]>([])
const expiry = ref<LinkExpiry>('30d')
const loading = ref(false)
const creating = ref(false)
const error = ref('')
const info = ref('')

const EXPIRIES: Array<{ label: string; value: LinkExpiry }> = [
  { label: '7 Tage', value: '7d' },
  { label: '30 Tage', value: '30d' },
  { label: '90 Tage', value: '90d' },
  { label: 'Unbegrenzt', value: 'never' },
]

watch(
  () => props.visible,
  async (open) => {
    if (!open || props.collectionId === null) return
    error.value = ''
    info.value = ''
    loading.value = true
    try {
      links.value = (await listCollectionPublicLinks(props.collectionId)).items
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Links konnten nicht geladen werden.'
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

function urlOf(link: CollectionPublicLink): string {
  return new URL(router.resolve({ name: 'shared-collection', params: { token: link.token } }).href, window.location.origin).toString()
}

function until(link: CollectionPublicLink): string {
  return link.expires_at ? `gilt bis ${new Date(link.expires_at).toLocaleDateString('de-DE')}` : 'unbegrenzt gültig'
}

async function copy(link: CollectionPublicLink) {
  try {
    await navigator.clipboard.writeText(urlOf(link))
    info.value = 'Link kopiert.'
  } catch {
    error.value = 'Kopieren ging nicht; der Link steht in der Liste.'
  }
}

async function create() {
  if (props.collectionId === null) return
  creating.value = true
  error.value = ''
  try {
    const link = await createCollectionPublicLink(props.collectionId, expiry.value)
    links.value = [link, ...links.value]
    await copy(link)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Link konnte nicht erstellt werden.'
  } finally {
    creating.value = false
  }
}

function end(link: CollectionPublicLink) {
  confirm.require({
    header: 'Link beenden?',
    message: `Wer den Link (${until(link)}) hat, sieht „${props.name}“ danach nicht mehr.`,
    icon: 'pi pi-exclamation-triangle',
    acceptLabel: 'Beenden',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await disableCollectionPublicLink(link.id)
        links.value = links.value.filter((l) => l.id !== link.id)
      } catch (err: unknown) {
        error.value = err instanceof Error ? err.message : 'Beenden fehlgeschlagen.'
      }
    },
  })
}

const hasLinks = computed(() => links.value.length > 0)
</script>

<template>
  <Dialog
    class="dialog-sm"
    :visible="visible"
    modal
    :header="`Freigabelink: ${name}`"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="share-body">
      <Message v-if="error" severity="error" :closable="true" @close="error = ''">{{ error }}</Message>
      <Message v-if="info" severity="success" :closable="true" @close="info = ''">{{ info }}</Message>
      <p class="share-hint">
        Wer den Link hat, sieht ohne Anmeldung die Fotos, Alben und Dokumente dieser Mappe, so wie sie gerade ist.
        Fotos gehen ohne Aufnahmeort und Kameradaten raus. Buchungen, Wertpapiere, Zähler und geschwärzte Dokumente
        bleiben draußen.
      </p>

      <div class="share-new">
        <label class="share-label" for="share-expiry">Gültig</label>
        <Select v-model="expiry" input-id="share-expiry" :options="EXPIRIES" option-label="label" option-value="value" class="share-grow" />
        <Button label="Link erstellen" icon="pi pi-globe" size="small" :loading="creating" data-testid="share-link-create" @click="create" />
      </div>

      <p v-if="loading" class="share-hint"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> Wird geladen …</p>
      <ul v-else-if="hasLinks" class="share-list" aria-label="Aktive Links">
        <li v-for="link in links" :key="link.id" class="share-row">
          <div class="share-row-body">
            <span class="share-url">{{ urlOf(link) }}</span>
            <span class="share-hint">{{ until(link) }}</span>
          </div>
          <Button icon="pi pi-copy" text rounded aria-label="Link kopieren" v-tooltip.bottom="'Link kopieren'" @click="copy(link)" />
          <Button icon="pi pi-times" text rounded severity="danger" aria-label="Link beenden" v-tooltip.bottom="'Link beenden'" @click="end(link)" />
        </li>
      </ul>
      <p v-else class="share-hint">Noch kein Link.</p>
    </div>
    <template #footer>
      <Button label="Schließen" severity="secondary" text @click="emit('update:visible', false)" />
    </template>
  </Dialog>
</template>

<style scoped>
.share-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  /* Room above the first control; the dialog body clips at its top edge. */
  padding-top: var(--focus-ring-reach);
}
.share-hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.share-label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.share-new {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.share-grow {
  flex: 1 1 8rem;
  min-width: 0;
}
.share-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.share-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.share-row-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.share-url {
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
