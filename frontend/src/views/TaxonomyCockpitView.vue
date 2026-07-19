<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import Chart from 'primevue/chart'
import {
  getTaxonomyCockpit,
  triggerSnapshot,
  type TaxonomySnapshot,
  type Recommendation,
  type CockpitResponse,
} from '../api/taxonomy-cockpit'

const loading = ref(true)
const snapshotting = ref(false)
const snapshots = ref<TaxonomySnapshot[]>([])
const recommendations = ref<Recommendation[]>([])
const error = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const data: CockpitResponse = await getTaxonomyCockpit()
    snapshots.value = data.snapshots
    recommendations.value = data.recommendations
  } catch (e: any) {
    error.value = e.message ?? 'Fehler beim Laden'
  } finally {
    loading.value = false
  }
}

async function onTriggerSnapshot() {
  snapshotting.value = true
  try {
    await triggerSnapshot()
    await load()
  } catch (e: any) {
    error.value = e.message ?? 'Snapshot fehlgeschlagen'
  } finally {
    snapshotting.value = false
  }
}

onMounted(load)

const latest = computed(() => snapshots.value[0] ?? null)
const previous = computed(() => snapshots.value[1] ?? null)

function delta(current: number | null | undefined, prev: number | null | undefined): string {
  if (current == null || prev == null) return ''
  const diff = current - prev
  if (diff === 0) return ''
  const sign = diff > 0 ? '+' : ''
  return `${sign}${Number.isInteger(diff) ? diff : diff.toFixed(1)}`
}

function deltaClass(current: number | null | undefined, prev: number | null | undefined, inverse = false): string {
  if (current == null || prev == null) return ''
  const diff = current - prev
  if (diff === 0) return ''
  const positive = inverse ? diff < 0 : diff > 0
  return positive ? 'delta-positive' : 'delta-negative'
}

const chartData = computed(() => {
  const sorted = [...snapshots.value].reverse()
  const labels = sorted.map(s => s.snapshot_date.slice(5))
  return {
    labels,
    datasets: [
      {
        label: 'Sonstiges %',
        data: sorted.map(s => s.sonstiges_pct),
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245,158,11,0.1)',
        tension: 0.3,
        fill: true,
        yAxisID: 'y',
      },
      {
        label: 'Ø Confidence',
        data: sorted.map(s => s.avg_confidence != null ? Math.round(s.avg_confidence * 100) : null),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16,185,129,0.1)',
        tension: 0.3,
        fill: false,
        yAxisID: 'y',
      },
    ],
  }
})

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: {
    legend: { position: 'top' as const },
    tooltip: { mode: 'index' as const },
  },
  scales: {
    y: {
      type: 'linear' as const,
      position: 'left' as const,
      min: 0,
      title: { display: true, text: '%' },
    },
  },
}))

const volumeChartData = computed(() => {
  const sorted = [...snapshots.value].reverse()
  const labels = sorted.map(s => s.snapshot_date.slice(5))
  return {
    labels,
    datasets: [
      {
        label: 'Gesamt',
        data: sorted.map(s => s.total_documents),
        borderColor: '#6366f1',
        tension: 0.3,
        fill: false,
      },
      {
        label: 'Klassifiziert',
        data: sorted.map(s => s.classified_documents),
        borderColor: '#10b981',
        tension: 0.3,
        fill: false,
      },
      {
        label: 'Sonstiges',
        data: sorted.map(s => s.sonstiges_count),
        borderColor: '#f59e0b',
        tension: 0.3,
        fill: false,
      },
    ],
  }
})

const volumeChartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: { legend: { position: 'top' as const } },
  scales: {
    y: { type: 'linear' as const, min: 0, title: { display: true, text: 'Dokumente' } },
  },
}))

function severityColor(sev: Recommendation['severity']): "info" | "warn" | "error" | "success" | "secondary" | "contrast" | undefined {
  switch (sev) {
    case 'critical': return 'error'
    case 'warning': return 'warn'
    default: return 'info'
  }
}

function severityTag(sev: Recommendation['severity']): "danger" | "warn" | "info" | "success" | "secondary" | "contrast" | undefined {
  switch (sev) {
    case 'critical': return 'danger'
    case 'warning': return 'warn'
    default: return 'info'
  }
}
</script>

<template>
  <div class="cockpit-view">
    <div class="cockpit-header">
      <h2>Taxonomie-Cockpit</h2>
      <Button
        label="Snapshot jetzt"
        icon="pi pi-refresh"
        size="small"
        :loading="snapshotting"
        @click="onTriggerSnapshot"
      />
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div v-if="loading" class="cockpit-loading">
      <i class="pi pi-spin pi-spinner" style="font-size: 2rem"></i>
    </div>

    <template v-else-if="latest">
      <!-- KPI Cards -->
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Dokumente gesamt</div>
          <div class="kpi-value">{{ latest.total_documents }}</div>
          <div class="kpi-delta" :class="deltaClass(latest.total_documents, previous?.total_documents)">
            {{ delta(latest.total_documents, previous?.total_documents) }}
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Klassifiziert</div>
          <div class="kpi-value">{{ latest.classified_documents }}</div>
          <div class="kpi-delta" :class="deltaClass(latest.classified_documents, previous?.classified_documents)">
            {{ delta(latest.classified_documents, previous?.classified_documents) }}
          </div>
        </div>
        <div class="kpi-card highlight-warn" :class="{ 'highlight-critical': latest.sonstiges_pct > 8 }">
          <div class="kpi-label">Sonstiges</div>
          <div class="kpi-value">{{ latest.sonstiges_pct }}%</div>
          <div class="kpi-delta" :class="deltaClass(latest.sonstiges_pct, previous?.sonstiges_pct, true)">
            {{ delta(latest.sonstiges_pct, previous?.sonstiges_pct) }}
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Ø Confidence</div>
          <div class="kpi-value">{{ latest.avg_confidence != null ? (latest.avg_confidence * 100).toFixed(1) + '%' : '—' }}</div>
          <div class="kpi-delta" :class="deltaClass(latest.avg_confidence, previous?.avg_confidence)">
            {{ latest.avg_confidence != null && previous?.avg_confidence != null ? delta(Math.round(latest.avg_confidence * 1000) / 10, Math.round(previous.avg_confidence * 1000) / 10) : '' }}
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Niedrige Confidence</div>
          <div class="kpi-value">{{ latest.low_confidence_count }}</div>
          <div class="kpi-delta" :class="deltaClass(latest.low_confidence_count, previous?.low_confidence_count, true)">
            {{ delta(latest.low_confidence_count, previous?.low_confidence_count) }}
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Teacher-Warteschlange</div>
          <div class="kpi-value">{{ latest.teacher_requested_count }}</div>
          <div class="kpi-delta" :class="deltaClass(latest.teacher_requested_count, previous?.teacher_requested_count, true)">
            {{ delta(latest.teacher_requested_count, previous?.teacher_requested_count) }}
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Offene Vorschläge</div>
          <div class="kpi-value">{{ latest.open_suggestions_count }}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Kategorien belegt</div>
          <div class="kpi-value">{{ latest.category_count }}</div>
        </div>
      </div>

      <!-- Recommendations -->
      <div v-if="recommendations.length > 0" class="recommendations-section">
        <h3>Empfehlungen</h3>
        <div class="recommendations-list">
          <Message
            v-for="(rec, i) in recommendations"
            :key="i"
            :severity="severityColor(rec.severity)"
            :closable="false"
          >
            <template #default>
              <div class="rec-content">
                <Tag :severity="severityTag(rec.severity)" :value="rec.action" />
                <span class="rec-reason">{{ rec.reason }}</span>
              </div>
            </template>
          </Message>
        </div>
      </div>

      <!-- Charts -->
      <div v-if="snapshots.length > 1" class="charts-section">
        <h3>Trend (letzte {{ snapshots.length }} Tage)</h3>
        <div class="chart-grid">
          <div class="chart-card">
            <h4>Sonstiges-Quote &amp; Confidence</h4>
            <div class="chart-container">
              <Chart type="line" :data="chartData" :options="chartOptions" />
            </div>
          </div>
          <div class="chart-card">
            <h4>Dokumenten-Volumen</h4>
            <div class="chart-container">
              <Chart type="line" :data="volumeChartData" :options="volumeChartOptions" />
            </div>
          </div>
        </div>
      </div>

      <div v-else class="no-trend">
        <Message severity="info" :closable="false">
          Noch keine historischen Daten vorhanden. Der tägliche Cron-Job
          (04:30 UTC) erfasst automatisch Snapshots, oder klicke oben auf "Snapshot jetzt".
        </Message>
      </div>
    </template>

    <template v-else>
      <Message severity="info" :closable="false">
        Noch keine Snapshots vorhanden. Klicke auf "Snapshot jetzt", um den ersten zu erfassen.
      </Message>
    </template>
  </div>
</template>

<style scoped>
.cockpit-view {
  padding: 1.5rem;
  max-width: 1200px;
}

.cockpit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}
.cockpit-header h2 {
  margin: 0;
  color: var(--p-text-color);
}

.cockpit-loading {
  display: flex;
  justify-content: center;
  padding: 3rem;
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.kpi-card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.kpi-card.highlight-warn {
  border-color: var(--p-yellow-500);
}
.kpi-card.highlight-critical {
  border-color: var(--p-red-500);
  background: rgba(239, 68, 68, 0.05);
}

.kpi-label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.kpi-value {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--p-text-color);
}

.kpi-delta {
  font-size: 0.8rem;
  font-weight: 500;
}
.kpi-delta.delta-positive {
  color: var(--p-green-500);
}
.kpi-delta.delta-negative {
  color: var(--p-red-500);
}

.recommendations-section {
  margin-bottom: 2rem;
}
.recommendations-section h3 {
  margin: 0 0 0.75rem;
  color: var(--p-text-color);
}
.recommendations-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.rec-content {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.rec-reason {
  color: var(--p-text-color);
}

.charts-section h3 {
  margin: 0 0 1rem;
  color: var(--p-text-color);
}

.chart-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 1.5rem;
}

.chart-card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 1rem;
}
.chart-card h4 {
  margin: 0 0 0.75rem;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}

.chart-container {
  height: 250px;
  position: relative;
}

.no-trend {
  margin-top: 1rem;
}
</style>
