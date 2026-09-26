<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Select from 'primevue/select'
import Message from 'primevue/message'
import ScrollX from '../../layout/ScrollX.vue'
import { createForecastAccountItems, type ForecastLinkableAccount, type ForecastPerson } from '../../../api/finance'
import { formatEur } from './forecastModel'

/**
 * Savings and depot accounts that no forecast item is linked to yet. Each
 * chosen one becomes an asset item linked to the account, so its balance
 * stays current with every account sync.
 */

const props = defineProps<{
  visible: boolean
  accounts: ForecastLinkableAccount[]
  persons: ForecastPerson[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'created', count: number): void
}>()

const KIND_LABELS: Record<string, string> = {
  tagesgeld: 'Tagesgeld',
  festgeld: 'Festgeld',
  bausparen: 'Bausparen',
  depot: 'Depot',
}

/** PrimeVue's Select shows nothing for `null`, so the household gets a sentinel id. */
const HOUSEHOLD = 0
const personOptions = computed(() => [
  { value: HOUSEHOLD, label: 'Haushalt' },
  ...props.persons.map((p) => ({ value: p.id, label: p.label })),
])

const chosen = ref<Set<number>>(new Set())
const personOf = ref<Record<number, number>>({})
const saving = ref(false)
const error = ref<string | null>(null)

watch(
  () => [props.visible, props.accounts] as const,
  ([v]) => {
    if (!v) return
    chosen.value = new Set(props.accounts.map((a) => a.id))
    personOf.value = Object.fromEntries(props.accounts.map((a) => [a.id, HOUSEHOLD]))
    error.value = null
  },
  { immediate: true },
)

function toggle(id: number, on: boolean) {
  const next = new Set(chosen.value)
  if (on) next.add(id)
  else next.delete(id)
  chosen.value = next
}

async function save() {
  saving.value = true
  error.value = null
  try {
    const list = props.accounts
      .filter((a) => chosen.value.has(a.id))
      .map((a) => ({ accountId: a.id, personId: personOf.value[a.id] === HOUSEHOLD ? null : (personOf.value[a.id] ?? null) }))
    const res = await createForecastAccountItems(list)
    emit('created', res.created)
    emit('update:visible', false)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    class="dialog-md"
    header="Konten übernehmen"
    @update:visible="emit('update:visible', $event)"
  >
    <p class="muted acc__hint">
      Diese Spar- und Depotkonten stehen noch nicht in der Prognose. Übernommene Konten werden als Vermögen verknüpft; ihr Saldo bleibt mit jedem Kontoabruf aktuell. Girokonten sind laufendes Geld und fehlen hier absichtlich.
    </p>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <ScrollX>
      <table class="acc__table">
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">Übernehmen</span></th>
            <th scope="col">Konto</th>
            <th scope="col" class="num">Saldo</th>
            <th scope="col">Gehört zu</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in accounts" :key="a.id">
            <td>
              <Checkbox :model-value="chosen.has(a.id)" binary :input-id="`acc-${a.id}`" @update:model-value="toggle(a.id, $event)" />
            </td>
            <td>
              <label :for="`acc-${a.id}`">{{ a.label }}</label>
              <span class="muted acc__kind">{{ KIND_LABELS[a.kind] ?? a.kind }}</span>
            </td>
            <td class="num">{{ formatEur(a.balance) }}</td>
            <td>
              <Select
                v-model="personOf[a.id]"
                :options="personOptions"
                option-label="label"
                option-value="value"
                size="small"
                :disabled="!chosen.has(a.id)"
                :aria-label="`Person für ${a.label}`"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </ScrollX>

    <template #footer>
      <Button label="Abbrechen" severity="secondary" text @click="emit('update:visible', false)" />
      <Button
        :label="chosen.size === 1 ? '1 Konto übernehmen' : `${chosen.size} Konten übernehmen`"
        icon="pi pi-check"
        :loading="saving"
        :disabled="chosen.size === 0"
        @click="save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.acc__hint {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
}
.acc__table {
  border-collapse: collapse;
  width: 100%;
}
.acc__table th,
.acc__table td {
  text-align: left;
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}
.acc__table th {
  font-weight: 600;
  font-size: var(--text-sm);
}
.acc__kind {
  display: block;
  font-size: var(--text-xs);
}
.num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.muted {
  color: var(--p-text-muted-color);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
