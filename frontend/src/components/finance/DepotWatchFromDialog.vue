<script setup lang="ts">
import { ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import Message from 'primevue/message'
import { useConfirm } from 'primevue/useconfirm'
import { listDepotWatchFrom, setDepotWatchFrom, type DepotWatchFrom } from '../../api/finance'
import { formatIsoDate } from '../../utils/financeFormat'
import { parseLocalDate, toLocalIsoDate } from '../../utils/dateFormat'

/**
 * The day each depot is looked at from. An old yearly statement lists
 * securities long sold; with a start day after it, nothing before that day
 * counts — the holdings reconciliation, the performance and the
 * transactions leave it out, and the papers are not read in again.
 */

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  'update:visible': [value: boolean]
  /** A start day changed: the portfolio's figures are stale. */
  changed: []
}>()

const confirm = useConfirm()
const depots = ref<DepotWatchFrom[]>([])
const drafts = ref<Record<number, Date | null>>({})
const loading = ref(false)
const saving = ref<number | null>(null)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

watch(
  () => props.visible,
  async (open) => {
    if (!open) return
    error.value = null
    notice.value = null
    loading.value = true
    try {
      depots.value = (await listDepotWatchFrom()).depots
      drafts.value = Object.fromEntries(
        depots.value.map((d) => [d.account_id, d.watch_from ? parseLocalDate(d.watch_from) : null]),
      )
    } catch (e: any) {
      error.value = e?.message ?? 'Depots konnten nicht geladen werden'
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

function draftDay(d: DepotWatchFrom): string | null {
  const v = drafts.value[d.account_id]
  return v ? toLocalIsoDate(v) : null
}

function dirty(d: DepotWatchFrom): boolean {
  return draftDay(d) !== d.watch_from
}

function ask(d: DepotWatchFrom) {
  const day = draftDay(d)
  // Moving the day later deletes what lies before it: ask first, naming it.
  if (day !== null && (d.watch_from === null || day > d.watch_from)) {
    confirm.require({
      header: 'Ältere Daten entfernen',
      message:
        `Bestände und Transaktionen des Depots „${d.label}“ vor dem ${formatIsoDate(day)} werden gelöscht ` +
        'und nicht mehr eingelesen. Die Belege bleiben im Dokumentmodul; von Hand erfasste Transaktionen ' +
        'bleiben, zählen aber nicht mehr.',
      icon: 'pi pi-exclamation-triangle',
      rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
      acceptProps: { label: 'Entfernen', severity: 'danger' },
      accept: () => { void save(d, day) },
    })
    return
  }
  void save(d, day)
}

async function save(d: DepotWatchFrom, day: string | null) {
  saving.value = d.account_id
  error.value = null
  notice.value = null
  try {
    const r = await setDepotWatchFrom(d.account_id, day)
    d.watch_from = r.watch_from
    const removed = r.holdings_removed + r.transactions_removed
    notice.value = day === null
      ? `„${d.label}“ wird wieder ganz betrachtet. „Belege einlesen“ holt ältere Stände zurück.`
      : removed > 0
        ? `„${d.label}“ ab ${formatIsoDate(day)}: ${r.holdings_removed} Bestandszeilen und ${r.transactions_removed} Transaktionen entfernt.`
        : `„${d.label}“ wird ab ${formatIsoDate(day)} betrachtet.`
    emit('changed')
  } catch (e: any) {
    error.value = e?.message ?? 'Das Datum konnte nicht gespeichert werden'
  } finally {
    saving.value = null
  }
}
</script>

<template>
  <Dialog
    class="dialog-md"
    :visible="visible"
    modal
    header="Depots betrachten ab"
    @update:visible="emit('update:visible', $event)"
  >
    <p class="dw-hint">
      Was vor diesem Tag liegt, zählt nicht: alte Depotauszüge, Abrechnungen und Kontobuchungen werden nicht
      eingelesen und fehlen im Bestandsabgleich und in der Performance. Leer heißt: die ganze Geschichte.
    </p>
    <Message v-if="error" severity="error" :closable="true" @close="error = null">{{ error }}</Message>
    <Message v-if="notice" severity="success" :closable="true" @close="notice = null">{{ notice }}</Message>

    <p v-if="loading" class="dw-hint">Lädt …</p>
    <p v-else-if="depots.length === 0" class="dw-hint">Keine Depots.</p>
    <ul v-else class="dw-list">
      <li v-for="d in depots" :key="d.account_id" class="dw-row">
        <label :for="`dw-${d.account_id}`" class="dw-label">
          {{ d.label }}<span v-if="d.closed" class="dw-muted"> (geschlossen)</span>
        </label>
        <div class="dw-controls">
          <DatePicker
            v-model="drafts[d.account_id]"
            :input-id="`dw-${d.account_id}`"
            date-format="dd.mm.yy"
            show-icon
            show-button-bar
            size="small"
            placeholder="ganze Geschichte"
          />
          <Button
            label="Übernehmen"
            size="small"
            :loading="saving === d.account_id"
            :disabled="!dirty(d) || saving !== null"
            @click="ask(d)"
          />
        </div>
      </li>
    </ul>

    <template #footer>
      <Button label="Schließen" severity="secondary" @click="emit('update:visible', false)" />
    </template>
  </Dialog>
</template>

<style scoped>
.dw-hint {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
}
.dw-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.dw-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--p-content-border-color);
}
.dw-label {
  font-weight: 600;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dw-muted {
  font-weight: normal;
  color: var(--p-text-muted-color);
}
.dw-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
</style>
