<script setup lang="ts">
/**
 * The PDF of a photo book (documentation/plans/fotobuch.md): for a print shop
 * — cover with spine and the inside, with bleed, as spreads or single pages —
 * or one file to print at home. The print settings are saved with the book,
 * then the server renders in the background and this dialog polls.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import RadioButton from 'primevue/radiobutton'
import {
  getPhotoBookExport,
  photoBookFileUrl,
  startPhotoBookExport,
  updatePhotoBook,
  type PhotoBook,
  type PhotoBookExportMode,
  type PhotoBookExportStatus,
} from '../../api/photoBooks'

const props = defineProps<{ visible: boolean; book: PhotoBook }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'saved', book: PhotoBook): void
}>()

const mode = ref<PhotoBookExportMode>('print')
const bleed = ref<number | null>(3)
const cropMarks = ref(false)
const spreads = ref(true)
const paper = ref<number | null>(0.12)
const status = ref<PhotoBookExportStatus | null>(null)
const starting = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

const FILE_LABELS: Record<string, string> = {
  cover: 'Umschlag (PDF)',
  inside: 'Innenseiten (PDF)',
  book: 'Fotobuch (PDF)',
}

const spineMm = computed(() => {
  const pages = props.book.page_count + (props.book.page_count % 2)
  return Math.round(Math.ceil(pages / 2) * (paper.value ?? 0) * 10) / 10
})

const running = computed(() => status.value?.status === 'running')

function stopPolling() {
  if (timer) clearTimeout(timer)
  timer = null
}

async function poll() {
  stopPolling()
  try {
    status.value = await getPhotoBookExport(props.book.id)
  } catch (err: any) {
    error.value = err?.message ?? 'Status nicht abrufbar.'
    return
  }
  if (status.value.status === 'running' && props.visible) timer = setTimeout(poll, 1500)
}

watch(() => props.visible, (open) => {
  if (!open) {
    stopPolling()
    return
  }
  const s = props.book.settings
  bleed.value = s.bleed_mm
  cropMarks.value = s.crop_marks
  spreads.value = s.spreads
  paper.value = s.paper_mm
  error.value = ''
  void poll()
}, { immediate: true })

onBeforeUnmount(stopPolling)

async function start() {
  if (starting.value || running.value) return
  starting.value = true
  error.value = ''
  try {
    if (mode.value === 'print') {
      const saved = await updatePhotoBook(props.book.id, {
        settings: { bleed_mm: bleed.value ?? 0, crop_marks: cropMarks.value, spreads: spreads.value, paper_mm: paper.value ?? 0.12 },
      })
      emit('saved', saved)
    }
    status.value = await startPhotoBookExport(props.book.id, mode.value)
    if (status.value.status === 'running') timer = setTimeout(poll, 1500)
  } catch (err: any) {
    error.value = err?.message ?? 'Das PDF konnte nicht gestartet werden.'
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <Dialog
    class="dialog-md"
    :visible="visible"
    modal
    header="Als PDF ausgeben"
    @update:visible="emit('update:visible', $event)"
  >
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <fieldset class="pbe-modes">
      <legend>Wofür</legend>
      <div class="pbe-row">
        <RadioButton v-model="mode" input-id="pbe-print" value="print" />
        <label for="pbe-print">Für die Druckerei – Umschlag mit Rücken und Innenseiten, mit Beschnitt</label>
      </div>
      <div class="pbe-row">
        <RadioButton v-model="mode" input-id="pbe-home" value="home" />
        <label for="pbe-home">Zum Selbstdrucken – eine Seite nach der anderen, ohne Beschnitt</label>
      </div>
    </fieldset>

    <div v-if="mode === 'print'" class="pbe-print">
      <div class="pbe-row">
        <label for="pbe-bleed">Beschnitt</label>
        <InputNumber v-model="bleed" input-id="pbe-bleed" :min="0" :max="10" :max-fraction-digits="1" suffix=" mm" class="pbe-number" />
      </div>
      <div class="pbe-row">
        <label for="pbe-paper">Papierstärke je Blatt</label>
        <InputNumber v-model="paper" input-id="pbe-paper" :min="0.03" :max="1" :min-fraction-digits="2" :max-fraction-digits="3" suffix=" mm" class="pbe-number" />
      </div>
      <p class="pbe-hint">Buchrücken bei {{ book.page_count }} Seiten: {{ spineMm.toLocaleString('de-DE') }} mm. Die Druckerei nennt Beschnitt und Papierstärke in ihren Vorgaben.</p>
      <div class="pbe-row">
        <Checkbox v-model="spreads" binary input-id="pbe-spreads" />
        <label for="pbe-spreads">Doppelseiten – linke und rechte Seite auf einer PDF-Seite</label>
      </div>
      <div class="pbe-row">
        <Checkbox v-model="cropMarks" binary input-id="pbe-marks" />
        <label for="pbe-marks">Schnittmarken</label>
      </div>
    </div>

    <Message v-if="book.low_dpi_count" severity="warn" :closable="false">
      {{ book.low_dpi_count === 1 ? 'Ein Foto wird' : `${book.low_dpi_count} Fotos werden` }} mit weniger als 200 dpi gedruckt und kann unscharf wirken.
    </Message>

    <div v-if="status && status.status !== 'none'" class="pbe-status" aria-live="polite">
      <template v-if="status.status === 'running'">
        <span>PDF wird erstellt …</span>
        <ProgressBar :value="Math.round(status.progress * 100)" />
      </template>
      <Message v-else-if="status.status === 'failed'" severity="error" :closable="false">
        Das PDF ist fehlgeschlagen{{ status.error ? `: ${status.error}` : '.' }}
      </Message>
      <div v-else class="pbe-files">
        <span>Fertig{{ status.mode === 'print' ? ' (für die Druckerei)' : ' (zum Selbstdrucken)' }}:</span>
        <a v-for="f in status.files" :key="f.kind" :href="photoBookFileUrl(f.url)" download class="pbe-link">
          <i class="pi pi-download" aria-hidden="true" /> {{ FILE_LABELS[f.kind] }}
        </a>
      </div>
    </div>

    <template #footer>
      <Button label="Schließen" severity="secondary" text @click="emit('update:visible', false)" />
      <Button label="PDF erstellen" icon="pi pi-file-pdf" :loading="starting || running" @click="start" />
    </template>
  </Dialog>
</template>

<style scoped>
.pbe-modes {
  border: 0;
  padding: 0;
  margin: 0 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pbe-modes legend {
  margin-bottom: var(--space-2);
  color: var(--p-text-muted-color);
}
.pbe-print {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.pbe-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.pbe-number :deep(input) {
  width: 7rem;
}
.pbe-hint {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.pbe-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.pbe-files {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.pbe-link {
  color: var(--p-primary-color);
}
.pbe-link:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
