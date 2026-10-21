<script setup lang="ts">
/**
 * Removing idle OSM regions (osm-admin/retention.ts): the switch, the
 * period, and what the nightly sweep will remove when.
 */
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import ToggleSwitch from 'primevue/toggleswitch'
import {
  getOsmRegionRetention,
  updateOsmRegionRetention,
  type RegionRetention,
} from '../../api/osmAdmin'

/** Must match MIN_IDLE_DAYS in osm-admin/retention.ts. */
const MIN_IDLE_DAYS = 7

const retention = ref<RegionRetention | null>(null)
const enabled = ref(true)
const idleDays = ref<number | null>(180)
const saving = ref(false)
const error = ref('')

const dirty = computed(() =>
  retention.value !== null
  && (enabled.value !== retention.value.settings.enabled
    || idleDays.value !== retention.value.settings.idleDays),
)

/** Soonest first; regions a trip keeps come last. */
const upcoming = computed(() =>
  [...(retention.value?.regions ?? [])].sort((a, b) =>
    (a.removeAfter ?? '9999').localeCompare(b.removeAfter ?? '9999')),
)

function apply(r: RegionRetention) {
  retention.value = r
  enabled.value = r.settings.enabled
  idleDays.value = r.settings.idleDays
}

async function load() {
  try {
    apply(await getOsmRegionRetention())
    error.value = ''
  } catch (err) {
    error.value = (err as Error).message ?? String(err)
  }
}

async function save() {
  if (idleDays.value === null || idleDays.value < MIN_IDLE_DAYS) {
    error.value = `Die Frist muss mindestens ${MIN_IDLE_DAYS} Tage betragen.`
    return
  }
  saving.value = true
  try {
    apply(await updateOsmRegionRetention(enabled.value, idleDays.value))
    error.value = ''
  } catch (err) {
    error.value = (err as Error).message ?? String(err)
  } finally {
    saving.value = false
  }
}

function formatDate(ts: string | null): string {
  if (!ts) return '–'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleDateString()
}

onMounted(load)
</script>

<template>
  <section class="osm-retention" aria-labelledby="osm-retention-title">
    <h4 id="osm-retention-title">Ungenutzte Regionen automatisch entfernen</h4>
    <p class="osm-retention__desc">
      Jede Abfrage einer Region (Ortsnamen von Fotos, POI-Erkennung, Reiseplanung)
      zählt als Nutzung. Wird eine Region länger als die Frist nicht genutzt, entfernt
      ein nächtlicher Lauf ihre Datenbank; die PBF-Datei und die Routing-Kacheln
      verschwinden danach von selbst. Regionen, die eine kommende oder laufende Reise
      braucht, bleiben stehen. Wird die Region später wieder gebraucht, wird sie neu
      importiert.
    </p>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div class="osm-retention__form">
      <label class="osm-retention__toggle">
        <ToggleSwitch v-model="enabled" input-id="osm-retention-enabled" />
        <span>Automatisch entfernen</span>
      </label>
      <label class="osm-retention__days">
        <span>Frist in Tagen</span>
        <InputNumber
          v-model="idleDays"
          input-id="osm-retention-days"
          :min="MIN_IDLE_DAYS"
          :max="3650"
          :use-grouping="false"
          :disabled="!enabled"
        />
      </label>
      <Button
        label="Speichern"
        icon="pi pi-check"
        size="small"
        :loading="saving"
        :disabled="!dirty"
        @click="save"
      />
    </div>

    <template v-if="retention">
      <p v-if="retention.settings.lastRunAt" class="osm-retention__last">
        Letzter Lauf: {{ formatDate(retention.settings.lastRunAt) }}<template
          v-if="retention.settings.lastRemoved.length > 0"
        > · zuletzt entfernt: {{ retention.settings.lastRemoved.join(', ') }}</template>
      </p>
      <ul v-if="enabled && upcoming.length > 0" class="osm-retention__list">
        <li v-for="r in upcoming" :key="r.slug">
          <code>{{ r.slug }}</code>
          <span v-if="r.keptForTrip" class="osm-retention__kept">bleibt — für eine Reise geplant</span>
          <span v-else-if="r.due" class="osm-retention__due">wird beim nächsten Lauf entfernt</span>
          <span v-else>ungenutzt seit {{ formatDate(r.idleSince) }},
            entfernt ab {{ formatDate(r.removeAfter) }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.osm-retention {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-4);
  align-self: stretch;
}

.osm-retention h4,
.osm-retention p {
  margin: 0;
}

.osm-retention__desc,
.osm-retention__last {
  color: var(--p-text-muted-color);
}

.osm-retention__form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
}

.osm-retention__toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.osm-retention__days {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.osm-retention__days :deep(input) {
  width: 7rem;
}

.osm-retention__list {
  margin: 0;
  padding-left: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.osm-retention__list li {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.osm-retention__kept {
  color: var(--p-text-muted-color);
}

.osm-retention__due {
  color: var(--p-red-500);
}
</style>
