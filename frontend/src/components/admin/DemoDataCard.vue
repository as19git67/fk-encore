<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import { cancelDemo, getDemoStatus, removeDemo, startDemo, type DemoContentCounts, type DemoStatus } from '../../api/demo'
import { useConfirmAsync } from '../../composables/useConfirmAsync'

/**
 * Demo data for a fresh system (documentation/plans/demodaten.md): load it
 * while nobody has put anything in, watch it load, take it back. The card
 * hides itself for a user the server does not let in (no Admin role).
 */

const status = ref<DemoStatus | null>(null)
const hidden = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null

const run = computed(() => status.value?.run ?? null)
const loading = computed(() => run.value?.status === 'running' || run.value?.status === 'cancelling')

const COUNT_LABELS: Record<keyof DemoContentCounts, string> = {
  users: 'Benutzer',
  photos: 'Fotos',
  documents: 'Dokumente',
  transactions: 'Buchungen',
  depot_transactions: 'Depotbuchungen',
  meter_readings: 'Zählerstände',
  trip_plans: 'Reisen',
}

const SUMMARY_LABELS: Record<string, string> = {
  users: 'zweite Benutzerin',
  accounts: 'Konten',
  bookings: 'Buchungen',
}

const STAGE_LABELS: Record<string, string> = {
  household: 'Haushalt',
  bookings: 'Buchungen',
  remove: 'Entfernen',
}

/** Why the button is not offered: what the system holds already. */
const heldLine = computed(() => {
  const c = status.value?.counts
  if (!c) return ''
  return (Object.keys(COUNT_LABELS) as Array<keyof DemoContentCounts>)
    .filter((k) => c[k] > 0)
    .map((k) => `${c[k]} ${COUNT_LABELS[k]}`)
    .join(', ')
})

const progress = computed(() => {
  const r = run.value
  if (!r?.stage) return null
  const p = r.progress[r.stage]
  return {
    label: STAGE_LABELS[r.stage] ?? r.stage,
    done: p?.done ?? 0,
    total: p?.total ?? 0,
    percent: p && p.total ? Math.round((p.done / p.total) * 100) : 0,
  }
})

const summaryLine = computed(() => {
  const s = run.value?.summary
  if (!s) return ''
  return Object.entries(s)
    .map(([k, n]) => `${n} ${SUMMARY_LABELS[k] ?? k}`)
    .join(', ')
})

const outcomeLine = computed(() => {
  switch (run.value?.status) {
    case 'done': return 'Demodaten sind geladen.'
    case 'cancelled': return 'Abgebrochen — was bis dahin geschrieben war, liegt noch im System.'
    case 'failed': return `Fehlgeschlagen: ${run.value.error ?? 'unbekannter Fehler'}. Was bis dahin geschrieben war, liegt noch im System.`
    case 'removing': return 'Demodaten werden entfernt …'
    default: return ''
  }
})

function schedule() {
  if (timer) clearTimeout(timer)
  timer = loading.value || run.value?.status === 'removing' ? setTimeout(() => void refresh(), 1500) : null
}

async function refresh() {
  try {
    status.value = await getDemoStatus()
    error.value = null
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'permission_denied') hidden.value = true
    else error.value = e instanceof Error ? e.message : 'Status nicht abrufbar.'
  }
  schedule()
}

async function act(fn: () => Promise<DemoStatus>) {
  busy.value = true
  try {
    status.value = await fn()
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Aktion fehlgeschlagen.'
  } finally {
    busy.value = false
    schedule()
  }
}

const askConfirm = useConfirmAsync()

async function remove() {
  const what = summaryLine.value ? ` (${summaryLine.value})` : ''
  if (!(await askConfirm({
    header: 'Demodaten entfernen',
    message: `Alles entfernen, was die Demo angelegt hat${what}? Die Demo-Benutzerin, ihre Konten und alle Buchungen darauf werden gelöscht. Was du selbst angelegt hast, bleibt.`,
    acceptLabel: 'Entfernen',
    danger: true,
  }))) return
  await act(removeDemo)
}

onMounted(() => void refresh())
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })
</script>

<template>
  <section v-if="!hidden" class="demo-section">
    <h2 class="demo-section__title">Demodaten</h2>
    <div class="demo-card">
    <div class="demo-card__head">
      <i class="pi pi-box" />
      <span class="demo-card__label">Demodaten</span>
    </div>
    <p class="demo-card__desc">
      Ein Beispielhaushalt zum Ausprobieren: eine zweite Benutzerin, ein gemeinsames Konto und drei Jahre
      Buchungen. Nur in einem System, in das noch niemand etwas eingetragen hat.
    </p>

    <p v-if="!status && !error" class="demo-card__line">Wird geladen …</p>

    <template v-else-if="status && !run">
      <Button
        v-if="status.untouched"
        label="Demodaten laden"
        icon="pi pi-download"
        size="small"
        outlined
        :loading="busy"
        @click="act(startDemo)"
      />
      <p v-else class="demo-card__line">
        Nicht verfügbar: Das System enthält schon Daten ({{ heldLine }}).
      </p>
    </template>

    <template v-else-if="run && loading">
      <p class="demo-card__line" aria-live="polite">
        {{ run.status === 'cancelling' ? 'Wird abgebrochen …' : `Wird geladen: ${progress?.label ?? '…'}` }}
        <template v-if="progress && progress.total">({{ progress.done }} von {{ progress.total }})</template>
      </p>
      <ProgressBar :value="progress?.percent ?? 0" :show-value="false" class="demo-card__bar" />
      <Button
        label="Abbrechen"
        icon="pi pi-times"
        size="small"
        severity="secondary"
        outlined
        :disabled="run.status === 'cancelling'"
        :loading="busy"
        @click="act(cancelDemo)"
      />
    </template>

    <template v-else-if="run">
      <p class="demo-card__line" aria-live="polite">{{ outcomeLine }}</p>
      <p v-if="summaryLine" class="demo-card__line">{{ summaryLine }}</p>
      <Button
        v-if="run.status !== 'removing'"
        label="Demodaten entfernen"
        icon="pi pi-trash"
        size="small"
        severity="danger"
        outlined
        :loading="busy"
        @click="remove"
      />
    </template>

    <p v-if="error" class="demo-card__warn">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped>
.demo-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-self: stretch;
}

.demo-section__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}

.demo-card {
  max-width: 32rem;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 0.85rem 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  background: var(--p-content-background);
}

.demo-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 600;
}

.demo-card__desc {
  margin: 0;
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
}

.demo-card__line {
  margin: 0;
  font-size: var(--text-base);
}

.demo-card__warn {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-tag-warn-color);
}

.demo-card__bar {
  align-self: stretch;
  height: var(--space-2);
}
</style>
