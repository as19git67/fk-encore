<script setup lang="ts">
/**
 * The local model's work on a photo book (documentation/plans/fotobuch.md,
 * stages 2 and 3): captions, chapter titles and the layout of each page. The
 * server runs it in the background; this dialog starts it and polls. What the
 * user wrote or picked stays — the dialog says so, so nobody hesitates.
 *
 * Below the start, how often the user changed the rule's layouts against the
 * model's: the model's picks are worth taking when they are changed no more
 * often.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import {
  getPhotoBookAi,
  getPhotoBookLayoutStats,
  startPhotoBookAi,
  type PhotoBookAiStatus,
  type PhotoBookAiTask,
  type PhotoBookLayoutStats,
} from '../../api/photoBooks'

const props = defineProps<{ visible: boolean; bookId: number }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  /** The job wrote something: the book should be loaded again. */
  (e: 'changed'): void
}>()

const captions = ref(true)
const chapters = ref(true)
const layouts = ref(false)
const overwrite = ref(false)
const status = ref<PhotoBookAiStatus | null>(null)
const stats = ref<PhotoBookLayoutStats | null>(null)
const starting = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

const running = computed(() => status.value?.status === 'running')
const tasks = computed<PhotoBookAiTask[]>(() => {
  const out: PhotoBookAiTask[] = []
  if (captions.value) out.push('captions')
  if (chapters.value) out.push('chapters')
  if (layouts.value) out.push('layouts')
  return out
})
const progress = computed(() => {
  const job = status.value?.job
  return job && job.total ? Math.round((job.done / job.total) * 100) : 0
})

function stopPolling() {
  if (timer) clearTimeout(timer)
  timer = null
}

async function poll() {
  stopPolling()
  const wasRunning = running.value
  try {
    status.value = await getPhotoBookAi(props.bookId)
  } catch (err: any) {
    error.value = err?.message ?? 'Status nicht abrufbar.'
    return
  }
  if (status.value.status === 'running') {
    if (props.visible) timer = setTimeout(poll, 2000)
  } else if (wasRunning) {
    emit('changed')
    void loadStats()
  }
}

async function loadStats() {
  try {
    stats.value = await getPhotoBookLayoutStats()
  } catch {
    stats.value = null
  }
}

watch(() => props.visible, (open) => {
  if (!open) {
    stopPolling()
    return
  }
  error.value = ''
  void poll()
  void loadStats()
}, { immediate: true })

onBeforeUnmount(stopPolling)

async function start() {
  if (starting.value || running.value || !tasks.value.length) return
  starting.value = true
  error.value = ''
  try {
    status.value = await startPhotoBookAi(props.bookId, tasks.value, overwrite.value)
    if (status.value.status === 'running') timer = setTimeout(poll, 2000)
  } catch (err: any) {
    error.value = err?.message ?? 'Die KI-Vorschläge konnten nicht gestartet werden.'
  } finally {
    starting.value = false
  }
}

function share(changed: number, pages: number): string {
  return pages ? `${Math.round((changed / pages) * 100)} %` : '–'
}
</script>

<template>
  <Dialog
    class="dialog-md"
    :visible="visible"
    modal
    header="Vorschläge der KI"
    @update:visible="emit('update:visible', $event)"
  >
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <p class="pba-intro">
      Die KI auf dem eigenen Server sieht sich die Fotos an und schreibt Vorschläge. Was du selbst geschrieben oder gewählt hast, bleibt stehen.
    </p>

    <fieldset class="pba-tasks">
      <legend>Was vorschlagen</legend>
      <div class="pba-row">
        <Checkbox v-model="captions" binary input-id="pba-captions" />
        <label for="pba-captions">Bildunterschriften – aus Ort, Sehenswürdigkeit mit Wikipedia, Personen und dem Bild</label>
      </div>
      <div class="pba-row">
        <Checkbox v-model="chapters" binary input-id="pba-chapters" />
        <label for="pba-chapters">Kapitelüberschriften – aus Zeit, Orten, Personen und den Bildunterschriften</label>
      </div>
      <div class="pba-row">
        <Checkbox v-model="layouts" binary input-id="pba-layouts" />
        <label for="pba-layouts">Seitenlayouts – die KI wählt unter den Vorschlägen der Regel, nie eines, das deutlich mehr beschneidet</label>
      </div>
      <div v-if="captions" class="pba-row pba-sub">
        <Checkbox v-model="overwrite" binary input-id="pba-overwrite" />
        <label for="pba-overwrite">Frühere KI-Bildunterschriften neu schreiben</label>
      </div>
    </fieldset>

    <div v-if="status?.job" class="pba-status" aria-live="polite">
      <template v-if="status.status === 'running'">
        <span>Die KI arbeitet … {{ status.job.done }} von {{ status.job.total }}</span>
        <ProgressBar :value="progress" />
      </template>
      <Message v-else-if="status.status === 'failed'" severity="error" :closable="false">
        {{ status.job.error ?? 'Die KI-Vorschläge sind fehlgeschlagen.' }}
      </Message>
      <Message v-else severity="success" :closable="false">
        Fertig: {{ status.job.captions }} Bildunterschriften, {{ status.job.chapters }} Kapitelüberschriften, {{ status.job.layouts }} Layouts.
        <template v-if="status.job.skipped"> Für {{ status.job.skipped }} hatte die KI keinen brauchbaren Vorschlag.</template>
      </Message>
    </div>

    <section v-if="stats && (stats.llm.pages || stats.rule.pages)" class="pba-stats" aria-labelledby="pba-stats-h">
      <h3 id="pba-stats-h">Wie oft du Layouts geändert hast</h3>
      <p>
        Von der Regel gewählt: {{ stats.rule.pages }} Seiten, davon {{ share(stats.rule.changed, stats.rule.pages) }} geändert.
        Von der KI gewählt: {{ stats.llm.pages }} Seiten, davon {{ share(stats.llm.changed, stats.llm.pages) }} geändert.
      </p>
    </section>

    <template #footer>
      <Button label="Schließen" severity="secondary" text @click="emit('update:visible', false)" />
      <Button label="Vorschläge holen" icon="pi pi-sparkles" :disabled="!tasks.length" :loading="starting || running" @click="start" />
    </template>
  </Dialog>
</template>

<style scoped>
.pba-intro {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
}
.pba-tasks {
  border: 0;
  padding: 0;
  margin: 0 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pba-tasks legend {
  margin-bottom: var(--space-2);
  color: var(--p-text-muted-color);
}
.pba-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.pba-sub {
  padding-left: var(--space-5);
}
.pba-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.pba-stats h3 {
  margin: 0 0 var(--space-1);
  font-size: var(--text-base);
}
.pba-stats p {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
</style>
