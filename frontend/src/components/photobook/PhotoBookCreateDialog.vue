<script setup lang="ts">
/**
 * "Fotobuch gestalten": builds a photo book from a selection, an album, a
 * collection or the basket (documentation/plans/fotobuch.md) and opens it.
 * The narrowing — quality, aesthetics, no recognisable faces, at most N
 * photos, more or fewer of a subject, one photo per series — is chosen here;
 * the book keeps it, "Neu verteilen" applies it again and "Auswahl" on the
 * book's page changes it.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import PhotoBookNarrowingFields from './PhotoBookNarrowingFields.vue'
import { PHOTO_BOOK_FORMATS, createPhotoBook, type PhotoBookFormat } from '../../api/photoBooks'
import { draftToNarrowing, narrowingDraft } from '../../utils/photoBookNarrowing'

const props = defineProps<{
  visible: boolean
  /** A selection; or `albumId`, or `collectionId` (a collection or the basket). */
  photoIds?: number[]
  albumId?: number
  collectionId?: number
  /** How the source reads in the lead ("Aus dem Basket."); a default per source otherwise. */
  sourceLabel?: string
  defaultTitle?: string
}>()

const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const router = useRouter()

const title = ref('')
const format = ref<PhotoBookFormat>('a4-landscape')
const draft = ref(narrowingDraft())
const creating = ref(false)
const error = ref('')

watch(() => props.visible, (open) => {
  if (!open) return
  title.value = props.defaultTitle ?? ''
  error.value = ''
})

const sourceText = computed(() => {
  if (props.sourceLabel) return props.sourceLabel
  if (props.albumId) return 'Aus allen Fotos des Albums.'
  if (props.collectionId) return 'Aus den Fotos und Alben der Sammelmappe.'
  const n = props.photoIds?.length ?? 0
  return n === 1 ? 'Aus dem gewählten Foto.' : `Aus den ${n} gewählten Fotos.`
})

async function create() {
  if (!title.value.trim() || creating.value) return
  creating.value = true
  error.value = ''
  try {
    const book = await createPhotoBook({
      title: title.value.trim(),
      format: format.value,
      ...(props.albumId
        ? { albumId: props.albumId }
        : props.collectionId
          ? { collectionId: props.collectionId }
          : { photoIds: props.photoIds ?? [] }),
      ...draftToNarrowing(draft.value),
    })
    emit('update:visible', false)
    void router.push({ name: 'fotos-photo-book', params: { id: book.id } })
  } catch (err: any) {
    error.value = err?.code === 'failed_precondition'
      ? 'Nach dem Eingrenzen bleibt kein Foto übrig.'
      : err?.message ?? 'Das Fotobuch konnte nicht angelegt werden.'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <Dialog
    class="dialog-md"
    :visible="visible"
    modal
    header="Fotobuch gestalten"
    @update:visible="emit('update:visible', $event)"
  >
    <p class="pbc-lead">
      {{ sourceText }} Die Fotos werden nach Aufnahmezeit in Kapitel geteilt und auf Seiten verteilt;
      danach lässt sich jede Seite ändern.
    </p>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="pbc-grid">
      <label class="pbc-field">
        <span>Titel</span>
        <InputText v-model="title" autofocus data-testid="photo-book-title" @keyup.enter="create" />
      </label>
      <label class="pbc-field">
        <span>Format</span>
        <Select v-model="format" :options="PHOTO_BOOK_FORMATS" option-label="name" option-value="id" />
      </label>
    </div>

    <PhotoBookNarrowingFields v-model="draft" id-prefix="pbc" />

    <template #footer>
      <Button label="Abbrechen" severity="secondary" text @click="emit('update:visible', false)" />
      <Button label="Gestalten" icon="pi pi-book" :disabled="!title.trim()" :loading="creating" @click="create" />
    </template>
  </Dialog>
</template>

<style scoped>
.pbc-lead {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
}
.pbc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.pbc-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
</style>
