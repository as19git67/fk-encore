<script setup lang="ts">
/**
 * "Fotobuch gestalten": builds a photo book from a selection, an album, a
 * collection or the basket (documentation/plans/fotobuch.md) and opens it.
 * The narrowing — quality, aesthetics, no recognisable faces, at most N
 * photos, more or fewer of a subject, one photo per series — happens once,
 * here; the book keeps it and "Neu verteilen" applies it again.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import {
  PHOTO_BOOK_FORMATS,
  PHOTO_BOOK_SUBJECTS,
  createPhotoBook,
  type PhotoBookFormat,
  type PhotoBookSubject,
  type PhotoBookWeights,
} from '../../api/photoBooks'

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
const useQuality = ref(false)
const qualityMin = ref<number | null>(50)
const useAesthetic = ref(false)
const aestheticMin = ref<number | null>(50)
const withoutFaces = ref(false)
const useMax = ref(false)
const maxPhotos = ref<number | null>(120)
const seriesPicks = ref(true)
const weights = ref<Record<PhotoBookSubject, number>>({ people: 0, landscape: 0, nature: 0, buildings: 0 })
const WEIGHT_OPTIONS = [
  { label: 'Weniger', value: -1 },
  { label: 'Normal', value: 0 },
  { label: 'Mehr', value: 1 },
]
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
    const weighted: PhotoBookWeights = {}
    for (const s of PHOTO_BOOK_SUBJECTS) if (weights.value[s.id]) weighted[s.id] = weights.value[s.id]
    const book = await createPhotoBook({
      title: title.value.trim(),
      format: format.value,
      ...(props.albumId
        ? { albumId: props.albumId }
        : props.collectionId
          ? { collectionId: props.collectionId }
          : { photoIds: props.photoIds ?? [] }),
      weights: Object.keys(weighted).length ? weighted : null,
      groupPicksOnly: seriesPicks.value,
      qualityMin: useQuality.value ? qualityMin.value : null,
      aestheticMin: useAesthetic.value ? aestheticMin.value : null,
      withoutRecognisableFaces: withoutFaces.value,
      maxPhotos: useMax.value ? maxPhotos.value : null,
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

    <fieldset class="pbc-narrow">
      <legend>Eingrenzen (optional)</legend>
      <div class="pbc-row">
        <Checkbox v-model="useQuality" binary input-id="pbc-quality" />
        <label for="pbc-quality">Qualität mindestens</label>
        <InputNumber v-model="qualityMin" :min="0" :max="100" suffix=" %" :disabled="!useQuality" aria-label="Mindestqualität in Prozent" class="pbc-number" />
      </div>
      <div class="pbc-row">
        <Checkbox v-model="useAesthetic" binary input-id="pbc-aesthetic" />
        <label for="pbc-aesthetic">Ästhetik mindestens</label>
        <InputNumber v-model="aestheticMin" :min="0" :max="100" suffix=" %" :disabled="!useAesthetic" aria-label="Mindestwert Ästhetik in Prozent" class="pbc-number" />
      </div>
      <div class="pbc-row">
        <Checkbox v-model="withoutFaces" binary input-id="pbc-faces" />
        <label for="pbc-faces">Ohne erkennbare Gesichter</label>
      </div>
      <p class="pbc-hint">Kleine oder unscharfe Gesichter im Hintergrund zählen nicht als erkennbar.</p>
      <div class="pbc-row">
        <Checkbox v-model="useMax" binary input-id="pbc-max" />
        <label for="pbc-max">Höchstens</label>
        <InputNumber v-model="maxPhotos" :min="1" :max="600" suffix=" Fotos" :disabled="!useMax" aria-label="Höchstzahl der Fotos" class="pbc-number" />
      </div>
      <p class="pbc-hint">Mit Mindestwerten fallen Fotos ohne Bewertung heraus. Bei einer Höchstzahl bleiben die am besten bewerteten.</p>
      <div class="pbc-row">
        <Checkbox v-model="seriesPicks" binary input-id="pbc-series" />
        <label for="pbc-series">Aus Serien ähnlicher Fotos nur das beste</label>
      </div>
    </fieldset>

    <fieldset class="pbc-narrow pbc-weights">
      <legend>Gewichten (optional)</legend>
      <p class="pbc-hint">Mehr oder weniger von einem Motiv: das ändert, welche Fotos bei einer Höchstzahl bleiben und welche groß stehen.</p>
      <div v-for="s in PHOTO_BOOK_SUBJECTS" :key="s.id" class="pbc-weight">
        <span :id="`pbc-w-${s.id}`" class="pbc-weight-label">{{ s.label }}</span>
        <SelectButton
          v-model="weights[s.id]"
          :options="WEIGHT_OPTIONS"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          size="small"
          :aria-labelledby="`pbc-w-${s.id}`"
        />
      </div>
    </fieldset>

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
.pbc-narrow {
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  padding: var(--space-3);
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pbc-weights {
  margin-top: var(--space-3);
}
.pbc-weight {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.pbc-weight-label {
  min-width: 8rem;
}
.pbc-narrow legend {
  padding: 0 var(--space-1);
  color: var(--p-text-muted-color);
}
.pbc-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.pbc-number :deep(input) {
  width: 7rem;
}
.pbc-hint {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
</style>
