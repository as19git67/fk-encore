<script setup lang="ts">
/**
 * Finanzen › Betriebe (documentation/plans/betriebe-euer.md, stage 1): the
 * register of businesses in the tax sense — a leased farm, a PV system —
 * each a row that opens its assets and parcels. Creating one asks only for
 * the name and the kind; the tax form follows the kind.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Message from 'primevue/message'
import PageLayout from '../../components/layout/PageLayout.vue'
import ListToolbar from '../../components/layout/ListToolbar.vue'
import EmptyState from '../../components/layout/EmptyState.vue'
import PageSkeleton from '../../components/layout/PageSkeleton.vue'
import ErrorBanner from '../../components/layout/ErrorBanner.vue'
import { useListToolbar } from '../../composables/useListToolbar'
import { useAuthStore } from '../../stores/auth'
import { createBusiness, listBusinesses, type Business, type BusinessKind } from '../../api/finance'
import { BUSINESS_KIND_OPTIONS, businessKindLabel, taxSectionLabel } from '../../utils/businessLabels'

const router = useRouter()
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('finance.accounts.manage'))

const items = ref<Business[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref<string | null>(null)

const toolbar = useListToolbar({
  result: { loaded: () => items.value.length, loading: () => loading.value },
})

async function load() {
  loading.value = true
  error.value = null
  try {
    items.value = (await listBusinesses()).items
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Betriebe konnten nicht geladen werden'
  } finally {
    loading.value = false
    loaded.value = true
  }
}

onMounted(load)

// ── new business ────────────────────────────────────────────────────────

const dialogVisible = ref(false)
const saving = ref(false)
const saveError = ref<string | null>(null)
const form = ref<{ name: string; kind: BusinessKind }>({ name: '', kind: 'landwirtschaft' })

function openCreate() {
  form.value = { name: '', kind: 'landwirtschaft' }
  saveError.value = null
  dialogVisible.value = true
}

async function save() {
  if (!form.value.name.trim()) {
    saveError.value = 'Der Name fehlt.'
    return
  }
  saving.value = true
  saveError.value = null
  try {
    const created = await createBusiness({ name: form.value.name.trim(), kind: form.value.kind })
    dialogVisible.value = false
    void router.push({ name: 'finance-business-detail', params: { id: created.id } })
  } catch (e: unknown) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function open(b: Business) {
  void router.push({ name: 'finance-business-detail', params: { id: b.id } })
}
</script>

<template>
  <PageLayout
    title="Betriebe"
    hint="Verpachtete Landwirtschaft, PV-Anlage, Gewerbe: je Betrieb die Anlagegüter mit Abschreibung und die Flächen für die Steuer."
    :ready="loaded"
  >
    <template #actions>
      <Button v-if="canWrite" label="Neuer Betrieb" icon="pi pi-plus" size="small" @click="openCreate" />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar" />
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = null" />
    </template>

    <PageSkeleton v-if="loading && items.length === 0" variant="list" :count="3" />

    <EmptyState
      v-else-if="items.length === 0"
      icon="pi pi-warehouse"
      title="Noch kein Betrieb"
      :message="canWrite ? 'Lege den ersten Betrieb an — etwa die verpachtete Landwirtschaft oder die PV-Anlage.' : 'Es ist noch kein Betrieb angelegt.'"
    />

    <ul v-else class="business-list">
      <li v-for="b in items" :key="b.id">
        <button type="button" class="business-row" @click="open(b)">
          <i :class="['pi', b.kind === 'photovoltaik' ? 'pi-sun' : b.kind === 'landwirtschaft' ? 'pi-warehouse' : b.kind === 'vermietung' ? 'pi-home' : 'pi-briefcase']" aria-hidden="true" />
          <span class="business-main">
            <span class="business-name">{{ b.name }}</span>
            <span class="business-meta">{{ businessKindLabel(b.kind) }} · {{ taxSectionLabel(b.tax_section) }}</span>
          </span>
          <span class="business-counts">
            {{ b.asset_count }} {{ b.asset_count === 1 ? 'Anlagegut' : 'Anlagegüter' }}
            <template v-if="b.kind === 'landwirtschaft' || b.parcel_count > 0"> · {{ b.parcel_count }} {{ b.parcel_count === 1 ? 'Fläche' : 'Flächen' }}</template>
          </span>
          <i class="pi pi-chevron-right business-chevron" aria-hidden="true" />
        </button>
      </li>
    </ul>

    <Dialog v-model:visible="dialogVisible" modal header="Neuer Betrieb" class="dialog-sm">
      <Message v-if="saveError" severity="error" :closable="false">{{ saveError }}</Message>
      <div class="field">
        <label for="business-name">Name</label>
        <InputText id="business-name" v-model="form.name" autofocus placeholder="z. B. Landwirtschaft Musterhof" />
      </div>
      <div class="field">
        <label for="business-kind">Art</label>
        <Select id="business-kind" v-model="form.kind" :options="BUSINESS_KIND_OPTIONS" option-label="label" option-value="value" />
      </div>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="dialogVisible = false" />
        <Button label="Anlegen" icon="pi pi-check" :loading="saving" @click="save" />
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.business-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.business-row {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: 0.5rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  color: var(--p-text-color);
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.business-row:hover {
  background: var(--p-content-hover-background);
}

.business-row:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.business-row > .pi:first-child {
  font-size: var(--text-xl);
  color: var(--p-primary-color);
}

.business-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.business-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.business-meta,
.business-counts {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.business-chevron {
  color: var(--p-text-muted-color);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: var(--space-3);
}

@media (max-width: 639px) {
  .business-row {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .business-counts {
    grid-column: 2;
  }
}
</style>
