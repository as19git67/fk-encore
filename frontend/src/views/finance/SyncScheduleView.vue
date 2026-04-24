<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useBankcontactsStore } from '../../stores/finance/bankcontacts'
import { useSyncScheduleStore } from '../../stores/finance/syncSchedule'
import type { SyncSlot } from '../../api/finance'

const route = useRoute()
const router = useRouter()
const bcStore = useBankcontactsStore()
const scheduleStore = useSyncScheduleStore()

const bankcontactId = computed(() => Number(route.params.id))

const bankcontact = computed(() =>
  bcStore.items.find((b) => b.id === bankcontactId.value),
)

const slots = ref<SyncSlot[]>([])
const globalTz = ref('Europe/Berlin')
const saving = ref(false)
const error = ref<string | null>(null)

// Common IANA zones — the list isn't exhaustive but covers the likely
// user base; the backend accepts any valid IANA zone.
const TIMEZONES = [
  'Europe/Berlin',
  'Europe/London',
  'Europe/Vienna',
  'Europe/Zurich',
  'UTC',
]

const WEEKDAYS = [
  { label: 'Mo', value: 1 },
  { label: 'Di', value: 2 },
  { label: 'Mi', value: 3 },
  { label: 'Do', value: 4 },
  { label: 'Fr', value: 5 },
  { label: 'Sa', value: 6 },
  { label: 'So', value: 0 },
]

onMounted(async () => {
  if (bcStore.items.length === 0) await bcStore.refresh()
  const loaded = await scheduleStore.load(bankcontactId.value)
  slots.value = loaded
  const first = loaded[0]
  if (first) globalTz.value = first.tz
})

function addSlot() {
  slots.value = [
    ...slots.value,
    { weekdays: [1, 2, 3, 4, 5], time: '08:00', tz: globalTz.value },
  ]
}

function removeSlot(i: number) {
  slots.value = slots.value.filter((_, idx) => idx !== i)
}

function toggleWeekday(i: number, day: number) {
  const slot = slots.value[i]
  if (!slot) return
  const set = new Set(slot.weekdays)
  if (set.has(day)) set.delete(day)
  else set.add(day)
  const next: SyncSlot = {
    weekdays: [...set].sort((a, b) => a - b),
    time: slot.time,
    tz: slot.tz,
  }
  const copy = [...slots.value]
  copy[i] = next
  slots.value = copy
}

async function save() {
  saving.value = true
  error.value = null
  try {
    // Apply the globally chosen tz to all slots before save, so the
    // cron evaluates them consistently.
    const normalised = slots.value.map((s) => ({ ...s, tz: globalTz.value }))
    const resp = await scheduleStore.save(bankcontactId.value, normalised)
    slots.value = resp
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Sync-Zeiten{{ bankcontact ? ' — ' + bankcontact.name : '' }}</h1>
      <Button
        label="Zurück"
        icon="pi pi-arrow-left"
        severity="secondary"
        text
        @click="router.push({ name: 'finance-bankcontact-detail', params: { id: bankcontactId } })"
      />
    </header>

    <Message v-if="error" severity="error" :closable="true" @close="error = null">{{ error }}</Message>

    <section class="card">
      <div class="field">
        <label>Zeitzone (gilt für alle Slots)</label>
        <Select v-model="globalTz" :options="TIMEZONES" />
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Slots</h2>
        <Button label="+ Slot" size="small" @click="addSlot" />
      </div>
      <p v-if="slots.length === 0" class="hint">Keine Slots — Sync ist deaktiviert.</p>
      <div v-for="(slot, i) in slots" :key="i" class="slot-row">
        <div class="weekdays">
          <label v-for="wd in WEEKDAYS" :key="wd.value" class="wd">
            <Checkbox
              :modelValue="slot.weekdays.includes(wd.value)"
              :binary="true"
              @update:modelValue="toggleWeekday(i, wd.value)"
            />
            <span>{{ wd.label }}</span>
          </label>
        </div>
        <InputText v-model="slot.time" placeholder="HH:MM" class="time-input" />
        <Button icon="pi pi-trash" severity="danger" text @click="removeSlot(i)" />
      </div>

      <div class="actions">
        <Button label="Speichern" :loading="saving" @click="save" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 48rem;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.page-header h1 {
  margin: 0;
}
.card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-head h2 {
  margin: 0;
  font-size: 1rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.slot-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.5rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.25rem;
}
.weekdays {
  display: flex;
  gap: 0.5rem;
  flex: 1;
  flex-wrap: wrap;
}
.wd {
  display: flex;
  gap: 0.25rem;
  align-items: center;
  font-size: 0.875rem;
}
.time-input {
  width: 6rem;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.hint {
  color: var(--p-text-muted-color);
  margin: 0;
}
</style>
