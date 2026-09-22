<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import PageLayout from '../components/layout/PageLayout.vue'
import {
  getQuickEntryConfig,
  saveQuickEntryConfig,
  METER_TYPE_ICONS,
  METER_TYPE_LABELS,
  type MeterListItem,
  type QuickEntryItem,
} from '../api/meters'

const router = useRouter()
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const info = ref('')
const availableMeters = ref<MeterListItem[]>([])
const configuredItems = ref<QuickEntryItem[]>([])
const selectedMeterId = ref<number | null>(null)

const configuredIds = computed(() => new Set(configuredItems.value.map((item) => item.id)))
const addableMeterOptions = computed(() =>
  availableMeters.value
    .filter((meter) => !configuredIds.value.has(meter.id))
    .map((meter) => ({
      label: `${meter.name} · ${METER_TYPE_LABELS[meter.type]}`,
      value: meter.id,
    })),
)

function typeIcon(meter: MeterListItem) {
  return METER_TYPE_ICONS[meter.type] ?? 'pi pi-gauge'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await getQuickEntryConfig()
    availableMeters.value = res.availableMeters
    configuredItems.value = [...res.items].sort((a, b) => a.sortOrder - b.sortOrder)
  } catch (err: any) {
    error.value = err.message || 'Konfiguration konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

async function persistConfig(nextItems = configuredItems.value) {
  saving.value = true
  error.value = ''
  try {
    const res = await saveQuickEntryConfig(nextItems.map((item) => item.id))
    availableMeters.value = res.availableMeters
    configuredItems.value = [...res.items].sort((a, b) => a.sortOrder - b.sortOrder)
    info.value = 'Konfiguration gespeichert.'
  } catch (err: any) {
    error.value = err.message || 'Konfiguration konnte nicht gespeichert werden'
  } finally {
    saving.value = false
  }
}

async function addConfiguredMeter() {
  if (selectedMeterId.value === null) return
  const meter = availableMeters.value.find((candidate) => candidate.id === selectedMeterId.value)
  if (!meter) return
  selectedMeterId.value = null
  await persistConfig([
    ...configuredItems.value,
    { ...meter, sortOrder: configuredItems.value.length },
  ])
}

async function removeConfiguredMeter(index: number) {
  await persistConfig(configuredItems.value.filter((_, i) => i !== index))
}

async function moveConfiguredMeter(index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= configuredItems.value.length) return
  const next = [...configuredItems.value]
  const [item] = next.splice(index, 1)
  if (!item) return
  next.splice(target, 0, item)
  await persistConfig(next)
}

onMounted(load)
</script>

<template>
  <PageLayout
    title="Schnellerfassung konfigurieren"
    hint="Wähle die Zähler aus, die in der Schnell-Erfassung erscheinen sollen, und sortiere sie in deiner Ablese-Reihenfolge."
    width="normal"
    :ready="!loading"
  >
    <template #actions>
      <Button icon="pi pi-arrow-left" label="Zur Erfassung" severity="secondary" outlined @click="router.push({ name: 'zaehler-schnellerfassung' })" />
    </template>

    <template #notice>
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <Message v-else-if="info" severity="success" closable @close="info = ''">{{ info }}</Message>
    </template>

    <section class="card">
      <div class="section-title">
        <div>
          <h2>Zählerliste</h2>
          <p>Diese Konfiguration wird für deinen Benutzer gespeichert.</p>
        </div>
        <Tag :value="`${configuredItems.length} Zähler`" severity="secondary" />
      </div>

      <div class="add-row">
        <Select
          v-model="selectedMeterId"
          :options="addableMeterOptions"
          option-label="label"
          option-value="value"
          filter
          placeholder="Zähler hinzufügen …"
          class="add-select"
        />
        <Button icon="pi pi-plus" label="Hinzufügen" :disabled="selectedMeterId === null" :loading="saving" @click="addConfiguredMeter" />
      </div>

      <div v-if="configuredItems.length === 0" class="empty">
        Noch keine Zähler ausgewählt. Füge oben die Zähler hinzu, die du regelmäßig abliest.
      </div>
      <ol v-else class="config-list">
        <li v-for="(meter, index) in configuredItems" :key="meter.id">
          <span class="meter-icon"><i :class="typeIcon(meter)" /></span>
          <span class="config-name">
            <strong>{{ meter.name }}</strong>
            <small>{{ METER_TYPE_LABELS[meter.type] }} · {{ meter.unit }}</small>
          </span>
          <div class="config-actions">
            <Button icon="pi pi-arrow-up" aria-label="Zähler nach oben" text rounded severity="secondary" :disabled="index === 0 || saving" @click="moveConfiguredMeter(index, -1)" />
            <Button icon="pi pi-arrow-down" aria-label="Zähler nach unten" text rounded severity="secondary" :disabled="index === configuredItems.length - 1 || saving" @click="moveConfiguredMeter(index, 1)" />
            <Button icon="pi pi-times" aria-label="Zähler aus der Schnellerfassung nehmen" text rounded severity="danger" :disabled="saving" @click="removeConfiguredMeter(index)" />
          </div>
        </li>
      </ol>
    </section>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.section-title,
.add-row,
.config-list li {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.section-title {
  justify-content: space-between;
}

.section-title p,
.config-name small {
  color: var(--p-text-muted-color);
}

h2,
p {
  margin-top: 0;
}

.card {
  padding: 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 16px;
  background: var(--p-content-background);
}

.add-select {
  flex: 1;
  min-width: 0;
}

.empty {
  padding: 1rem;
  border: 1px dashed var(--p-content-border-color);
  border-radius: 12px;
  color: var(--p-text-muted-color);
}

.config-list {
  list-style: none;
  padding: 0;
  margin: 1rem 0 0;
  display: grid;
  gap: 0.5rem;
}

.config-list li {
  padding: 0.65rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 14px;
  background: var(--p-content-hover-background);
}

.meter-icon {
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 12%, transparent);
  flex: 0 0 auto;
}

.config-name {
  min-width: 0;
  flex: 1;
  display: grid;
}

.config-name strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
}

@media (max-width: 767px) {
  .section-title,
  .add-row {
    align-items: stretch;
    flex-direction: column;
  }

  .config-actions {
    gap: 0;
  }
}
</style>
