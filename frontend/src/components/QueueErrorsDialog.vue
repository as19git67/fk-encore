<script setup lang="ts">
/**
 * Generic "failed jobs, grouped by error message" dialog.
 *
 * Decoupled from any specific queue: the caller passes a `loader`
 * function that resolves to FailedJobGroup[]. That keeps the dialog
 * reusable for the scan queue today and the finance-tag queue later
 * (same response shape, different endpoint).
 */
import { ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import type { FailedJobGroup } from '../api/photos'

const props = defineProps<{
  visible: boolean
  title: string
  /** Resolves the grouped failures. `null` disables fetching. */
  loader: (() => Promise<FailedJobGroup[]>) | null
}>()

const emit = defineEmits<{ 'update:visible': [boolean] }>()

const loading = ref(false)
const error = ref('')
const groups = ref<FailedJobGroup[]>([])

// Re-fetch every time the dialog opens — the queue is live, so a stale
// snapshot from a previous open would mislead the operator.
watch(
  () => props.visible,
  async (open) => {
    if (!open || !props.loader) return
    loading.value = true
    error.value = ''
    groups.value = []
    try {
      groups.value = await props.loader()
    } catch (e: any) {
      error.value = e?.message ?? 'Fehler beim Laden der Fehlerdetails'
    } finally {
      loading.value = false
    }
  },
)

function close() {
  emit('update:visible', false)
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <Dialog
    :visible="visible"
    @update:visible="emit('update:visible', $event)"
    modal
    :header="title"
    :style="{ width: 'min(760px, 94vw)' }"
  >
    <div v-if="loading" class="qed-center">
      <ProgressSpinner style="width: 2.5rem; height: 2.5rem" />
    </div>

    <Message v-else-if="error" severity="error" :closable="false">
      {{ error }}
    </Message>

    <Message v-else-if="groups.length === 0" severity="success" :closable="false">
      Keine fehlgeschlagenen Jobs.
    </Message>

    <div v-else class="qed-table-wrap">
      <table class="qed-table">
        <thead>
          <tr>
            <th>Fehlermeldung</th>
            <th>Anzahl</th>
            <th>Zuletzt</th>
            <th>Beispiel-Foto-IDs</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(g, i) in groups" :key="i">
            <td class="qed-msg">{{ g.errorMsg }}</td>
            <td class="qed-count">{{ g.count }}</td>
            <td class="qed-when">{{ formatDate(g.lastFailedAt) }}</td>
            <td class="qed-ids">{{ g.samplePhotoIds.join(', ') || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <template #footer>
      <Button label="Schließen" @click="close" />
    </template>
  </Dialog>
</template>

<style scoped>
.qed-center {
  display: flex;
  justify-content: center;
  padding: 2rem 0;
}

.qed-table-wrap {
  overflow-x: auto;
}

.qed-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.qed-table th,
.qed-table td {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: top;
}

.qed-table th {
  font-weight: 600;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.qed-msg {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-word;
}

.qed-count {
  font-weight: 600;
  white-space: nowrap;
}

.qed-when {
  white-space: nowrap;
  color: var(--p-text-muted-color);
}

.qed-ids {
  color: var(--p-text-muted-color);
  word-break: break-word;
}
</style>
