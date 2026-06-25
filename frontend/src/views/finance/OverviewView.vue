<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import { useOverviewStore } from '../../stores/finance/overview'
import { useAnomalyStore } from '../../stores/finance/anomalies'
import { useAuthStore } from '../../stores/auth'
import type { OverviewAccount, SaveOverviewSection } from '../../api/finance'

const store = useOverviewStore()
const anomalyStore = useAnomalyStore()
const authStore = useAuthStore()
const router = useRouter()

const canWrite = computed(() => authStore.hasPermission('finance.accounts.manage'))

onMounted(() => {
  void store.refresh()
  void anomalyStore.refresh()
})

function openAnomalies() {
  void router.push({ name: 'finance-anomalies' })
}

function formatBalance(acc: OverviewAccount): string {
  if (acc.balance === null) return '—'
  const n = Number(acc.balance)
  if (!Number.isFinite(n)) return acc.balance
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: acc.currency_code || 'EUR',
  }).format(n)
}

function formatUpdatedAt(iso: string | null): string {
  if (!iso) return 'noch nicht aktualisiert'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'noch nicht aktualisiert'
  return `aktualisiert: ${d.toLocaleDateString('de-DE')}`
}

function balanceClass(acc: OverviewAccount): string {
  if (acc.balance === null) return 'balance balance-neutral'
  const n = Number(acc.balance)
  if (!Number.isFinite(n) || n === 0) return 'balance balance-neutral'
  return n < 0 ? 'balance balance-negative' : 'balance balance-positive'
}

// ----- Konfigurations-Dialog -----------------------------------------

interface DraftSection {
  name: string
  account_ids: number[]
}

const dialogVisible = ref(false)
const draft = ref<DraftSection[]>([])
const draftUnassigned = ref<number[]>([])
const dialogError = ref<string | null>(null)

function openConfig() {
  if (!store.data) return
  draft.value = store.data.sections.map((s) => ({
    name: s.name,
    account_ids: s.accounts.map((a) => a.id),
  }))
  draftUnassigned.value = store.data.unassigned.map((a) => a.id)
  // First-time users land on the synthesised default config — pre-fill
  // with the same shape so they can adjust labels and order without
  // rebuilding from scratch.
  if (store.data.is_default && draft.value.length > 0) {
    // already populated from sections above
  }
  dialogError.value = null
  dialogVisible.value = true
}

const accountById = computed(() => {
  const map = new Map<number, OverviewAccount>()
  if (store.data) {
    for (const s of store.data.sections) for (const a of s.accounts) map.set(a.id, a)
    for (const a of store.data.unassigned) map.set(a.id, a)
  }
  return map
})

// Options for the "In Gruppe …"-Select on each unassigned-pool row.
// Recomputed reactively so renaming a section is reflected in the
// dropdown without an extra dance.
const sectionOptions = computed(() =>
  draft.value.map((s, idx) => ({
    label: s.name.trim() || '(unbenannt)',
    value: idx,
  })),
)

function accountLabel(id: number): string {
  return accountById.value.get(id)?.label ?? `#${id}`
}

function addSection() {
  draft.value.push({ name: 'Neue Gruppe', account_ids: [] })
}

function removeSection(idx: number) {
  const s = draft.value[idx]
  if (!s) return
  // Spill its accounts back into the unassigned pool so they don't
  // silently disappear from the UI on save.
  draftUnassigned.value.push(...s.account_ids)
  draft.value.splice(idx, 1)
}

function moveSection(idx: number, dir: -1 | 1) {
  const newIdx = idx + dir
  if (newIdx < 0 || newIdx >= draft.value.length) return
  const a = draft.value[idx]
  const b = draft.value[newIdx]
  if (!a || !b) return
  draft.value[idx] = b
  draft.value[newIdx] = a
}

function moveAccountToSection(accountId: number, targetIdx: number) {
  // Remove from wherever it is currently.
  draftUnassigned.value = draftUnassigned.value.filter((id) => id !== accountId)
  for (const s of draft.value) {
    s.account_ids = s.account_ids.filter((id) => id !== accountId)
  }
  const target = draft.value[targetIdx]
  if (!target) return
  target.account_ids.push(accountId)
}

function moveAccountToUnassigned(accountId: number) {
  for (const s of draft.value) {
    s.account_ids = s.account_ids.filter((id) => id !== accountId)
  }
  if (!draftUnassigned.value.includes(accountId)) {
    draftUnassigned.value.push(accountId)
  }
}

function moveAccountWithinSection(sectionIdx: number, accountId: number, dir: -1 | 1) {
  const section = draft.value[sectionIdx]
  if (!section) return
  const ids = section.account_ids
  const cur = ids.indexOf(accountId)
  if (cur < 0) return
  const next = cur + dir
  if (next < 0 || next >= ids.length) return
  const a = ids[cur]
  const b = ids[next]
  if (a === undefined || b === undefined) return
  ids[cur] = b
  ids[next] = a
}

async function saveConfig() {
  dialogError.value = null
  // Strip out empty / whitespace-only names early so the user gets a
  // friendlier error than the backend's 80-char message.
  const cleaned: SaveOverviewSection[] = draft.value
    .map((s) => ({ name: s.name.trim(), account_ids: [...s.account_ids] }))
    .filter((s) => s.name.length > 0 || s.account_ids.length > 0)
  if (cleaned.some((s) => s.name.length === 0)) {
    dialogError.value = 'Jede Gruppe braucht einen Namen.'
    return
  }
  try {
    await store.save(cleaned)
    dialogVisible.value = false
  } catch (err) {
    dialogError.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Übersicht</h1>
    </header>

    <div
      v-if="anomalyStore.count > 0"
      class="anomaly-tile"
      role="button"
      tabindex="0"
      @click="openAnomalies"
      @keydown.enter="openAnomalies"
      @keydown.space.prevent="openAnomalies"
    >
      <div class="tile-icon">
        <i class="pi pi-exclamation-triangle" />
      </div>
      <div class="tile-body">
        <div class="tile-title">
          {{ anomalyStore.count }}
          {{ anomalyStore.count === 1 ? 'offene Anomalie' : 'offene Anomalien' }}
        </div>
        <div class="tile-sub">
          Auffälligkeiten bei wiederkehrenden Buchungen prüfen
        </div>
      </div>
      <i class="pi pi-chevron-right tile-chevron" />
    </div>

    <Message v-if="store.error" severity="error" :closable="false">
      {{ store.error }}
    </Message>

    <Message
      v-if="store.data?.is_default && !store.error"
      severity="info"
      :closable="false"
    >
      Diese Übersicht wird gerade aus deinen Kontotypen abgeleitet. Über
      „Übersicht konfigurieren" kannst du eigene Gruppen anlegen und die
      Reihenfolge anpassen.
    </Message>

    <div v-if="store.loading && !store.data" class="loading">Lädt …</div>

    <template v-else-if="store.data">
      <section v-if="store.data.sections.length === 0" class="empty">
        Noch keine Gruppen konfiguriert. Lege über „Übersicht konfigurieren"
        deine erste Gruppe an.
      </section>

      <section
        v-for="section in store.data.sections"
        :key="section.name"
        class="overview-section"
      >
        <h2>{{ section.name }}</h2>
        <div v-if="section.accounts.length === 0" class="section-empty">
          Keine Konten in dieser Gruppe.
        </div>
        <ul v-else class="account-card">
          <li class="account-row card-virtual">
            <div class="row-left">
              <div class="row-title">
                <RouterLink
                  :to="{ name: 'finance-section-transactions', params: { name: section.name } }"
                  class="row-label row-link"
                >
                  Alle Buchungen
                </RouterLink>
              </div>
            </div>
            <i class="pi pi-chevron-right row-chevron" />
          </li>
          <li
            v-for="acc in section.accounts"
            :key="acc.id"
            class="account-row"
          >
            <div class="row-left">
              <div class="row-title">
                <RouterLink
                  :to="{ name: 'finance-account-transactions', params: { id: acc.id } }"
                  class="row-label row-link"
                >
                  {{ acc.label }}
                </RouterLink>
                <span
                  v-if="acc.pending_count > 0"
                  class="row-badge"
                  :title="`${acc.pending_count} neue/unbearbeitete Buchungen`"
                >
                  {{ acc.pending_count }}
                </span>
              </div>
              <div class="row-sub">
                <template v-if="acc.type_kind === 'bargeld' && canWrite">
                  <RouterLink
                    :to="{
                      name: 'finance-transaction-new',
                      query: { accountId: acc.id },
                    }"
                    class="text-blue-500 hover:underline inline-flex items-center gap-1"
                    @click.stop
                  >
                    <i class="pi pi-plus-circle" /> Buchung hinzufügen
                  </RouterLink>
                </template>
                <template v-else>
                  {{ formatUpdatedAt(acc.balance_as_of) }}
                </template>
              </div>
            </div>
            <div :class="balanceClass(acc)">{{ formatBalance(acc) }}</div>
          </li>
        </ul>
      </section>

      <div class="config-button-row">
        <Button
          icon="pi pi-cog"
          label="Übersicht konfigurieren"
          severity="secondary"
          text
          :disabled="!store.data"
          @click="openConfig"
        />
      </div>
    </template>

    <Dialog
      v-model:visible="dialogVisible"
      modal
      header="Übersicht konfigurieren"
      :style="{ width: '40rem', maxWidth: '95vw' }"
    >
      <Message v-if="dialogError" severity="error" :closable="false">
        {{ dialogError }}
      </Message>

      <p class="hint">
        Lege Gruppen an (z. B. „Täglich" oder „Sparen") und ordne deine
        Konten zu. Konten ohne Gruppe werden unten unter „Nicht zugeordnet"
        angezeigt.
      </p>

      <div
        v-for="(section, idx) in draft"
        :key="idx"
        class="cfg-section"
      >
        <header class="cfg-section-head">
          <InputText
            v-model="section.name"
            placeholder="Gruppenname"
            class="cfg-section-name"
          />
          <div class="cfg-section-actions">
            <Button
              icon="pi pi-arrow-up"
              severity="secondary"
              text
              :disabled="idx === 0"
              @click="moveSection(idx, -1)"
            />
            <Button
              icon="pi pi-arrow-down"
              severity="secondary"
              text
              :disabled="idx === draft.length - 1"
              @click="moveSection(idx, 1)"
            />
            <Button
              icon="pi pi-trash"
              severity="danger"
              text
              @click="removeSection(idx)"
            />
          </div>
        </header>
        <ul class="cfg-account-list">
          <li
            v-for="accId in section.account_ids"
            :key="accId"
            class="cfg-account-row"
          >
            <span>{{ accountLabel(accId) }}</span>
            <span class="cfg-row-actions">
              <Button
                icon="pi pi-arrow-up"
                severity="secondary"
                text
                @click="moveAccountWithinSection(idx, accId, -1)"
              />
              <Button
                icon="pi pi-arrow-down"
                severity="secondary"
                text
                @click="moveAccountWithinSection(idx, accId, 1)"
              />
              <Button
                icon="pi pi-times"
                severity="secondary"
                text
                @click="moveAccountToUnassigned(accId)"
              />
            </span>
          </li>
          <li v-if="section.account_ids.length === 0" class="cfg-empty">
            Noch keine Konten in dieser Gruppe.
          </li>
        </ul>
      </div>

      <Button
        label="Gruppe hinzufügen"
        icon="pi pi-plus"
        severity="secondary"
        @click="addSection"
      />

      <h3 class="cfg-pool-title">Verfügbare Konten</h3>
      <ul class="cfg-account-list">
        <li
          v-for="accId in draftUnassigned"
          :key="accId"
          class="cfg-account-row cfg-pool-row"
        >
          <span class="cfg-pool-label">{{ accountLabel(accId) }}</span>
          <Select
            :options="sectionOptions"
            optionLabel="label"
            optionValue="value"
            placeholder="In Gruppe …"
            :model-value="null"
            class="cfg-pool-select"
            :disabled="draft.length === 0"
            @update:model-value="(idx: number | null) => idx !== null && moveAccountToSection(accId, idx)"
          />
        </li>
        <li v-if="draftUnassigned.length === 0" class="cfg-empty">
          Alle Konten sind zugeordnet.
        </li>
      </ul>

      <template #footer>
        <Button
          label="Abbrechen"
          severity="secondary"
          text
          @click="dialogVisible = false"
        />
        <Button
          label="Speichern"
          icon="pi pi-check"
          :loading="store.saving"
          @click="saveConfig"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1.5rem;
}

.anomaly-tile {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.85rem 1rem;
  border-radius: 0.5rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-left: 4px solid var(--p-yellow-500, #f59e0b);
  cursor: pointer;
  transition: background-color 120ms;
}
.anomaly-tile:hover,
.anomaly-tile:focus-visible {
  background: var(--p-content-hover-background);
  outline: none;
}
.anomaly-tile .tile-icon {
  font-size: 1.4rem;
  color: var(--p-yellow-500, #f59e0b);
  flex: 0 0 auto;
}
.anomaly-tile .tile-body {
  flex: 1;
  min-width: 0;
}
.anomaly-tile .tile-title {
  font-weight: 600;
  color: var(--p-text-color);
}
.anomaly-tile .tile-sub {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.anomaly-tile .tile-chevron {
  color: var(--p-text-muted-color);
}
@media (max-width: 640px) {
  .page {
    padding: 0.75rem;
    gap: 1rem;
  }
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.page-header h1 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}
.loading,
.empty {
  color: var(--p-text-muted-color);
  padding: 1rem 0;
}
.overview-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.overview-section h2 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--p-text-color);
}
.section-empty {
  color: var(--p-text-muted-color);
  font-style: italic;
  padding: 0.25rem 0.25rem 0.5rem;
}
.account-card {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.75rem;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
  transition: background 0.1s;
}
.account-row .row-sub > a {
  display: flex;
  gap: 0.25em;
}
.account-row + .account-row {
  border-top: 1px solid var(--p-content-border-color);
}
.account-row:hover {
  background: var(--p-content-hover-background);
}
.card-virtual {
  font-weight: 600;
}
.row-chevron {
  color: var(--p-text-muted-color);
}
.row-left {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.row-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.row-label {
  font-weight: 600;
}
.row-link {
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}
.row-link:hover {
  text-decoration: underline;
}
.row-link:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
  border-radius: 0.125rem;
}
.row-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  background: var(--p-primary-500, #4caf50);
  color: var(--p-primary-contrast-color, #fff);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
}
.row-sub {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.balance {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.balance-positive {
  color: var(--p-text-color);
}
.balance-negative {
  color: var(--p-red-500, #d32f2f);
}
.balance-neutral {
  color: var(--p-text-muted-color);
}
.config-button-row {
  display: flex;
  justify-content: flex-start;
  margin-top: 0.5rem;
}
/* ----- Dialog ----- */
.hint {
  color: var(--p-text-muted-color);
  margin: 0 0 1rem;
}
.cfg-section {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 0.75rem;
  margin-bottom: 0.75rem;
}
.cfg-section-head {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.5rem;
}
.cfg-section-name {
  flex: 1;
}
.cfg-section-actions {
  display: flex;
  gap: 0.25rem;
}
.cfg-account-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.cfg-account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: 0.375rem;
  background: var(--p-content-hover-background);
  flex-wrap: wrap;
}
.cfg-row-actions {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}
.cfg-pool-row {
  flex-wrap: nowrap;
}
.cfg-pool-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cfg-pool-select {
  flex-shrink: 0;
  min-width: 10rem;
  max-width: 14rem;
}
@media (max-width: 480px) {
  .cfg-pool-select {
    min-width: 8rem;
  }
}
.cfg-empty {
  color: var(--p-text-muted-color);
  font-style: italic;
  padding: 0.25rem 0.5rem;
}
.cfg-pool-title {
  font-size: 1rem;
  margin: 1rem 0 0.5rem;
}
</style>
