<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import {
  listTaxHints,
  updateTaxHint,
  resetTaxHint,
  reclassifyTaxSection,
  type TaxHintEntry,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'

type GroupKey = TaxHintEntry['group']

const GROUP_LABELS: Record<GroupKey, string> = {
  einkuenfte: 'Einkünfte',
  abzuege: 'Abzüge',
  bescheid: 'Bescheid',
  rahmen: 'Rahmen / Stammdaten',
}
const GROUP_ORDER: GroupKey[] = ['einkuenfte', 'abzuege', 'bescheid', 'rahmen']

const auth = useAuthStore()
const canManage = computed(() => auth.hasPermission('documents.manage_taxonomy'))

const loading = ref(true)
const error = ref('')
const infoMessage = ref('')
const items = ref<TaxHintEntry[]>([])

// Working-copy per slug so edits don't clash with reloads.
const drafts = reactive<Record<string, string>>({})
const savingBySlug = reactive<Record<string, boolean>>({})
const resettingBySlug = reactive<Record<string, boolean>>({})
const reclassifyingBySlug = reactive<Record<string, boolean>>({})

const grouped = computed(() => {
  const map = new Map<GroupKey, TaxHintEntry[]>()
  for (const group of GROUP_ORDER) map.set(group, [])
  for (const item of items.value) {
    map.get(item.group)?.push(item)
  }
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    entries: map.get(group) ?? [],
  }))
})

function applyEntry(entry: TaxHintEntry) {
  const idx = items.value.findIndex((e) => e.slug === entry.slug)
  if (idx >= 0) items.value[idx] = entry
  drafts[entry.slug] = entry.effective_hint
}

function isDirty(entry: TaxHintEntry): boolean {
  const draft = drafts[entry.slug] ?? ''
  return draft.trim() !== entry.effective_hint.trim()
}

function hasContent(entry: TaxHintEntry): boolean {
  return (drafts[entry.slug] ?? '').trim().length > 0
}

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const res = await listTaxHints()
    items.value = res.items
    for (const item of res.items) {
      drafts[item.slug] = item.effective_hint
    }
  } catch (err: any) {
    error.value = err.message || 'Hints konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

async function handleSave(entry: TaxHintEntry) {
  const draft = (drafts[entry.slug] ?? '').trim()
  if (draft.length === 0) return
  savingBySlug[entry.slug] = true
  error.value = ''
  infoMessage.value = ''
  try {
    const updated = await updateTaxHint(entry.slug, draft)
    applyEntry(updated)
    infoMessage.value = `Hint für "${updated.name}" gespeichert.`
  } catch (err: any) {
    error.value = err.message || 'Speichern fehlgeschlagen.'
  } finally {
    savingBySlug[entry.slug] = false
  }
}

async function handleReset(entry: TaxHintEntry) {
  resettingBySlug[entry.slug] = true
  error.value = ''
  infoMessage.value = ''
  try {
    const reset = await resetTaxHint(entry.slug)
    applyEntry(reset)
    infoMessage.value = `Hint für "${reset.name}" auf Standard zurückgesetzt.`
  } catch (err: any) {
    error.value = err.message || 'Zurücksetzen fehlgeschlagen.'
  } finally {
    resettingBySlug[entry.slug] = false
  }
}

// ─── Reclassify dialog ──────────────────────────────────────────────────
const reclassifyDialog = ref<{ entry: TaxHintEntry; includeReviewed: boolean } | null>(null)

function openReclassifyDialog(entry: TaxHintEntry) {
  reclassifyDialog.value = { entry, includeReviewed: false }
}

async function handleReclassify() {
  if (!reclassifyDialog.value) return
  const { entry, includeReviewed } = reclassifyDialog.value
  reclassifyingBySlug[entry.slug] = true
  error.value = ''
  infoMessage.value = ''
  try {
    const res = await reclassifyTaxSection(entry.slug, includeReviewed)
    infoMessage.value =
      res.queued === 0
        ? `Keine Dokumente mit "${entry.name}" zum Neuklassifizieren gefunden.`
        : `${res.queued} Dokument(e) mit "${entry.name}" in die Klassifizierungs-Queue gelegt.`
    reclassifyDialog.value = null
  } catch (err: any) {
    error.value = err.message || 'Neu-Klassifizierung konnte nicht gestartet werden.'
  } finally {
    reclassifyingBySlug[entry.slug] = false
  }
}

onMounted(loadData)
</script>

<template>
  <div class="tax-hints-view">
    <h1 class="title">Steuer-Hints für die Klassifizierung</h1>
    <p class="subtitle">
      Diese Texte werden dem LLM pro Anlage als Beispielbeschreibung mitgegeben.
      Je konkreter der Hint (typische Belege, Absender, Abgrenzungen), desto
      zuverlässiger landet ein Dokument in der richtigen Anlage. Änderungen
      wirken sofort beim nächsten Klassifizierungslauf.
    </p>

    <Message v-if="!canManage" severity="warn" :closable="false" class="mb">
      Keine Berechtigung (documents.manage_taxonomy).
    </Message>
    <Message v-if="error" severity="error" :closable="false" class="mb">{{ error }}</Message>
    <Message v-if="infoMessage" severity="success" :closable="true" class="mb">{{ infoMessage }}</Message>

    <div v-if="loading" class="loading">Lade …</div>

    <template v-else>
      <section v-for="group in grouped" :key="group.group" class="group">
        <h2 class="group-title">{{ group.label }}</h2>
        <div v-for="entry in group.entries" :key="entry.slug" class="hint-card">
          <div class="hint-header">
            <div class="hint-identity">
              <span class="hint-slug">{{ entry.slug }}</span>
              <span class="hint-name">{{ entry.name }}</span>
            </div>
            <span v-if="entry.is_overridden" class="badge overridden">Angepasst</span>
            <span v-else class="badge default">Standard</span>
          </div>

          <textarea
            v-model="drafts[entry.slug]"
            class="p-inputtext hint-textarea"
            rows="3"
            :disabled="!canManage"
            placeholder="Beispiel: Jahressteuerbescheinigung der Bank/Broker, Zins- und Dividendenabrechnungen …"
          />

          <div v-if="entry.is_overridden" class="default-hint">
            <span class="default-hint-label">Standard:</span>
            <span class="default-hint-text">{{ entry.default_hint }}</span>
          </div>

          <div class="hint-actions">
            <Button
              label="Speichern"
              icon="pi pi-save"
              :loading="savingBySlug[entry.slug]"
              :disabled="!canManage || !isDirty(entry) || !hasContent(entry)"
              @click="handleSave(entry)"
            />
            <Button
              label="Auf Standard zurücksetzen"
              icon="pi pi-undo"
              severity="secondary"
              :loading="resettingBySlug[entry.slug]"
              :disabled="!canManage || !entry.is_overridden"
              @click="handleReset(entry)"
            />
            <Button
              label="Dokumente neu klassifizieren"
              icon="pi pi-refresh"
              severity="info"
              :loading="reclassifyingBySlug[entry.slug]"
              :disabled="!canManage"
              @click="openReclassifyDialog(entry)"
            />
          </div>
        </div>
      </section>
    </template>

    <Dialog
      :visible="reclassifyDialog !== null"
      :header="'Neu klassifizieren: ' + (reclassifyDialog?.entry.name ?? '')"
      :modal="true"
      :style="{ width: '480px' }"
      @update:visible="(v) => { if (!v) reclassifyDialog = null }"
    >
      <p>
        Alle Dokumente, die aktuell dieser Anlage zugeordnet sind, werden neu
        durch das LLM klassifiziert. Es wird nur der Classify-Schritt erneut
        ausgeführt — die OCR-Texte bleiben unverändert.
      </p>
      <label class="include-reviewed">
        <input type="checkbox" :checked="reclassifyDialog?.includeReviewed ?? false" @change="(e) => { if (reclassifyDialog) reclassifyDialog.includeReviewed = (e.target as HTMLInputElement).checked }" />
        <span>Auch manuell bestätigte Dokumente einbeziehen (überschreibt Nutzerauswahl nicht)</span>
      </label>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" @click="reclassifyDialog = null" />
        <Button
          label="Starten"
          icon="pi pi-refresh"
          :loading="reclassifyingBySlug[reclassifyDialog?.entry.slug ?? ''] ?? false"
          @click="handleReclassify"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.tax-hints-view {
  padding: 1rem;
  max-width: 960px;
}

.title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.subtitle {
  color: var(--p-text-muted-color);
  max-width: 70ch;
  margin-block: 0 1.5rem;
}

.mb {
  margin-bottom: 1rem;
}

.loading {
  color: var(--p-text-muted-color);
  padding: 1rem 0;
}

.group {
  margin-bottom: 2rem;
}

.group-title {
  font-size: 0.95rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--p-text-muted-color);
  border-bottom: 1px solid var(--p-content-border-color);
  padding-bottom: 0.25rem;
  margin-bottom: 0.75rem;
}

.hint-card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 0.85rem 1rem;
  margin-bottom: 0.75rem;
  background: var(--p-content-background);
}

.hint-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.hint-identity {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.hint-slug {
  font-family: monospace;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.hint-name {
  font-weight: 600;
}

.badge {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-weight: 600;
}

.badge.overridden {
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}

.badge.default {
  background: var(--p-content-hover-background);
  color: var(--p-text-muted-color);
}

.hint-textarea {
  width: 100%;
  font-family: inherit;
  resize: vertical;
  min-height: 3.5rem;
}

.default-hint {
  font-size: 0.8rem;
  margin-top: 0.4rem;
  color: var(--p-text-muted-color);
  display: flex;
  gap: 0.35rem;
}

.default-hint-label {
  font-weight: 600;
}

.hint-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.6rem;
}

.include-reviewed {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
  font-size: 0.9rem;
}
</style>
