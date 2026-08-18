<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import DatePicker from 'primevue/datepicker'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import {
  createSubjectPerson,
  deleteSubjectPerson,
  listAssessmentSettings,
  listSubjectPersons,
  updateSubjectPerson,
  upsertAssessmentSetting,
  type AssessmentSetting,
  type AssessmentType,
  type CostBearer,
  type RelationKind,
  type SubjectPerson,
} from '../api/documents'
import { toLocalIsoDate } from '../utils/dateFormat'

// ─── relation kind options ──────────────────────────────────────────────────

const relationKindOptions: { value: RelationKind; label: string }[] = [
  { value: 'self', label: 'Ich selbst' },
  { value: 'spouse', label: 'Ehepartner:in' },
  { value: 'child', label: 'Kind' },
  { value: 'parent', label: 'Elternteil' },
  { value: 'sibling', label: 'Geschwister' },
  { value: 'ward', label: 'Betreute Person' },
  { value: 'other', label: 'Sonstige' },
]

const costBearerOptions: { value: CostBearer; label: string }[] = [
  { value: 'unknown', label: 'Unklar' },
  { value: 'user', label: 'Ich selbst' },
  { value: 'person', label: 'Die Person selbst' },
]

const assessmentTypeOptions: { value: AssessmentType; label: string }[] = [
  { value: 'unknown', label: 'Unbekannt' },
  { value: 'zusammen', label: 'Zusammenveranlagung' },
  { value: 'einzeln', label: 'Einzelveranlagung' },
]

// ─── state ──────────────────────────────────────────────────────────────────

const persons = ref<SubjectPerson[]>([])
const assessmentSettings = ref<AssessmentSetting[]>([])
const loading = ref(false)
const error = ref('')
const info = ref('')

const form = ref({
  full_name: '',
  relation_tag: '',
  relation_kind: 'other' as RelationKind,
  birth_date: null as Date | null,
  in_household: false,
  tax_cost_bearer: 'unknown' as CostBearer,
  own_tax_return_from_tax_year: null as number | null,
})
const adding = ref(false)
const deletingId = ref<number | null>(null)
const savingId = ref<number | null>(null)

const assessmentForm = ref({
  assessment_type: 'unknown' as AssessmentType,
  valid_from_tax_year: null as number | null,
})
const savingAssessment = ref(false)

// ─── data loading ───────────────────────────────────────────────────────────

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [personsRes, settingsRes] = await Promise.all([
      listSubjectPersons(),
      listAssessmentSettings(),
    ])
    persons.value = personsRes.items
    assessmentSettings.value = settingsRes.items
    if (settingsRes.items.length > 0) {
      const current = [...settingsRes.items].sort(
        (a, b) => (b.valid_from_tax_year ?? 0) - (a.valid_from_tax_year ?? 0),
      )[0]!
      assessmentForm.value.assessment_type = current.assessment_type
      assessmentForm.value.valid_from_tax_year = current.valid_from_tax_year
    }
  } catch (err: any) {
    error.value = err.message || 'Daten konnten nicht geladen werden'
  } finally {
    loading.value = false
  }
}

// ─── assessment settings ────────────────────────────────────────────────────

async function handleSaveAssessment() {
  savingAssessment.value = true
  error.value = ''
  info.value = ''
  try {
    await upsertAssessmentSetting({
      assessment_type: assessmentForm.value.assessment_type,
      valid_from_tax_year: assessmentForm.value.valid_from_tax_year,
    })
    await load()
    info.value = 'Veranlagungsart gespeichert'
  } catch (err: any) {
    error.value = err.message || 'Speichern fehlgeschlagen'
  } finally {
    savingAssessment.value = false
  }
}

// ─── subject person CRUD ────────────────────────────────────────────────────

async function handleAdd() {
  const full_name = form.value.full_name.trim()
  const relation_tag = form.value.relation_tag.trim()
  if (!full_name || !relation_tag) return
  adding.value = true
  error.value = ''
  info.value = ''
  try {
    const created = await createSubjectPerson({
      full_name,
      relation_tag,
      relation_kind: form.value.relation_kind,
      birth_date: form.value.birth_date ? toLocalIsoDate(form.value.birth_date) : null,
      in_household: form.value.in_household,
      tax_cost_bearer: form.value.tax_cost_bearer,
      own_tax_return_from_tax_year: form.value.own_tax_return_from_tax_year,
    })
    persons.value = [...persons.value, created].sort((a, b) =>
      a.full_name.localeCompare(b.full_name, 'de'),
    )
    form.value.full_name = ''
    form.value.relation_tag = ''
    form.value.relation_kind = 'other'
    form.value.birth_date = null
    form.value.in_household = false
    form.value.tax_cost_bearer = 'unknown'
    form.value.own_tax_return_from_tax_year = null
    info.value = `${created.full_name} hinzugefügt`
  } catch (err: any) {
    error.value = err.message || 'Speichern fehlgeschlagen'
  } finally {
    adding.value = false
  }
}

async function handleFieldChange(
  p: SubjectPerson,
  patch: Partial<{
    relation_kind: string
    birth_date: string | null
    in_household: boolean
    tax_cost_bearer: string
    requires_tax_review_override: boolean | null
    own_tax_return_from_tax_year: number | null
  }>,
) {
  savingId.value = p.id
  error.value = ''
  info.value = ''
  try {
    const updated = await updateSubjectPerson(p.id, patch)
    persons.value = persons.value.map((x) => (x.id === p.id ? updated : x))
  } catch (err: any) {
    error.value = err.message || 'Speichern fehlgeschlagen'
  } finally {
    savingId.value = null
  }
}

async function handleToggleTaxReview(p: SubjectPerson, checked: boolean) {
  await handleFieldChange(p, { requires_tax_review_override: checked })
  info.value = checked
    ? `Steuerdokumente von ${p.full_name} werden ab sofort zur Prüfung markiert.`
    : `Steuerdokumente von ${p.full_name} werden nicht mehr zur Prüfung markiert.`
}

async function handleResetTaxReviewOverride(p: SubjectPerson) {
  await handleFieldChange(p, { requires_tax_review_override: null })
  info.value = `Steuer-Prüfung für ${p.full_name} auf automatisch zurückgesetzt.`
}

async function handleOwnReturnChange(p: SubjectPerson, year: number | null) {
  if (year === p.own_tax_return_from_tax_year) return
  await handleFieldChange(p, { own_tax_return_from_tax_year: year })
  info.value =
    year === null
      ? `${p.full_name} macht keine eigene Steuererklärung mehr — Dokumente kommen zurück in deine Prüfung.`
      : `Steuerdokumente von ${p.full_name} ab Steuerjahr ${year} gehören ab sofort zur eigenen Steuerakte.`
}

async function handleDelete(p: SubjectPerson) {
  if (!confirm(`Bezugsperson "${p.full_name}" wirklich entfernen?`)) return
  deletingId.value = p.id
  error.value = ''
  try {
    await deleteSubjectPerson(p.id)
    persons.value = persons.value.filter((x) => x.id !== p.id)
    info.value = `${p.full_name} entfernt`
  } catch (err: any) {
    error.value = err.message || 'Löschen fehlgeschlagen'
  } finally {
    deletingId.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="subject-persons-view">
    <header class="page-header">
      <h1>Bezugspersonen &amp; Haushalt</h1>
      <p class="page-hint">
        Personen, die auf deinen Dokumenten vorkommen. Der Klassifizierer erkennt
        ihre Namen und ergänzt automatisch das Beziehungs-Tag. Die Beziehungsart
        bestimmt, ob Steuerdokumente dieser Person automatisch zur Prüfung
        markiert werden.
      </p>
      <p class="page-hint">
        Wird ein Kind erwachsen und macht eine eigene Steuererklärung, trage das
        erste betroffene Steuerjahr unter „Eigene Erklärung ab“ ein: Steuer&shy;dokumente
        ab diesem Jahr wandern in die eigene Steuerakte der Person statt in deine
        Prüf-Liste. Ältere Jahre bleiben unverändert bei dir.
      </p>
    </header>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>

    <!-- Assessment type -->
    <section class="assessment-section" aria-labelledby="assessment-heading">
      <h2 id="assessment-heading">Veranlagungsart</h2>
      <form class="assessment-form" @submit.prevent="handleSaveAssessment">
        <label>
          <span class="label">Veranlagung</span>
          <Select
            v-model="assessmentForm.assessment_type"
            :options="assessmentTypeOptions"
            option-label="label"
            option-value="value"
            :disabled="savingAssessment"
          />
        </label>
        <label>
          <span class="label">Gilt ab Steuerjahr (leer = immer)</span>
          <InputNumber
            v-model="assessmentForm.valid_from_tax_year"
            :use-grouping="false"
            :min="1990"
            :max="2099"
            placeholder="z. B. 2024"
            :disabled="savingAssessment"
          />
        </label>
        <Button
          type="submit"
          label="Speichern"
          icon="pi pi-check"
          :loading="savingAssessment"
          size="small"
        />
      </form>
      <p class="page-hint">
        Bei Zusammenveranlagung sind Arztkosten des Ehepartners automatisch
        absetzbar — die Steuer-Prüfung entfällt für Ehepartner:in und eigene
        Kinder im Haushalt.
      </p>
    </section>

    <!-- Add form -->
    <section class="add-form" aria-labelledby="add-heading">
      <h2 id="add-heading">Bezugsperson hinzufügen</h2>
      <form class="add-form__grid" @submit.prevent="handleAdd">
        <label>
          <span class="label">Name (wie auf dem Dokument)</span>
          <InputText
            v-model="form.full_name"
            placeholder="Erika Mustermann"
            :disabled="adding"
          />
        </label>
        <label>
          <span class="label">Beziehungs-Tag</span>
          <InputText
            v-model="form.relation_tag"
            placeholder="mutter"
            :disabled="adding"
          />
        </label>
        <label>
          <span class="label">Beziehungsart</span>
          <Select
            v-model="form.relation_kind"
            :options="relationKindOptions"
            option-label="label"
            option-value="value"
            :disabled="adding"
          />
        </label>
        <label>
          <span class="label">Geburtsdatum (optional)</span>
          <DatePicker
            v-model="form.birth_date"
            date-format="dd.mm.yy"
            :show-icon="true"
            :disabled="adding"
            placeholder="TT.MM.JJJJ"
          />
        </label>
        <label>
          <span class="label">Kostenträger</span>
          <Select
            v-model="form.tax_cost_bearer"
            :options="costBearerOptions"
            option-label="label"
            option-value="value"
            :disabled="adding"
          />
        </label>
        <label>
          <span class="label">Eigene Steuererklärung ab Steuerjahr</span>
          <InputNumber
            v-model="form.own_tax_return_from_tax_year"
            :use-grouping="false"
            :min="1990"
            :max="2099"
            placeholder="leer = keine"
            :disabled="adding"
          />
        </label>
        <label class="checkbox-label">
          <Checkbox v-model="form.in_household" :binary="true" :disabled="adding" />
          <span>Im Haushalt</span>
        </label>
        <div class="add-form__submit">
          <Button
            type="submit"
            label="Hinzufügen"
            icon="pi pi-plus"
            :loading="adding"
            :disabled="!form.full_name.trim() || !form.relation_tag.trim()"
          />
        </div>
      </form>
    </section>

    <!-- Table -->
    <DataTable
      :value="persons"
      :loading="loading"
      data-key="id"
      empty-message="Noch keine Bezugspersonen hinterlegt."
      class="persons-table"
      responsive-layout="scroll"
    >
      <Column field="full_name" header="Name" />
      <Column header="Tag">
        <template #body="{ data }">
          <Tag :value="data.relation_tag" severity="info" />
        </template>
      </Column>
      <Column header="Beziehung">
        <template #body="{ data }">
          <Select
            :model-value="data.relation_kind"
            :options="relationKindOptions"
            option-label="label"
            option-value="value"
            :disabled="savingId === data.id"
            class="inline-select"
            @update:model-value="(v: RelationKind) => handleFieldChange(data, { relation_kind: v })"
          />
        </template>
      </Column>
      <Column header="Haushalt" :style="{ width: '6rem' }">
        <template #body="{ data }">
          <Checkbox
            :model-value="data.in_household"
            :binary="true"
            :disabled="savingId === data.id"
            @update:model-value="(v: boolean) => handleFieldChange(data, { in_household: v })"
          />
        </template>
      </Column>
      <Column header="Kostenträger">
        <template #body="{ data }">
          <Select
            :model-value="data.tax_cost_bearer"
            :options="costBearerOptions"
            option-label="label"
            option-value="value"
            :disabled="savingId === data.id"
            class="inline-select"
            @update:model-value="(v: CostBearer) => handleFieldChange(data, { tax_cost_bearer: v })"
          />
        </template>
      </Column>
      <Column header="Eigene Erklärung ab" :style="{ width: '9rem' }">
        <template #body="{ data }">
          <InputNumber
            :model-value="data.own_tax_return_from_tax_year"
            :use-grouping="false"
            :min="1990"
            :max="2099"
            placeholder="—"
            :disabled="savingId === data.id"
            class="inline-year"
            @update:model-value="(v: number | null) => handleOwnReturnChange(data, v)"
          />
        </template>
      </Column>
      <Column header="Steuer-Prüfung" :style="{ width: '10rem' }">
        <template #body="{ data }">
          <div class="tax-review-cell">
            <Checkbox
              :model-value="data.requires_tax_review"
              :binary="true"
              :disabled="savingId === data.id || data.own_tax_return_from_tax_year !== null"
              @update:model-value="(v: boolean) => handleToggleTaxReview(data, v)"
            />
            <Tag
              v-if="data.own_tax_return_from_tax_year !== null"
              value="eigene Akte"
              severity="info"
              class="override-tag"
              v-tooltip="
                `Steuerdokumente ab ${data.own_tax_return_from_tax_year} gehören zur eigenen Steuerakte`
              "
            />
            <Tag
              v-else-if="data.requires_tax_review_override !== null"
              value="manuell"
              severity="warn"
              class="override-tag"
              :style="{ cursor: 'pointer' }"
              @click="handleResetTaxReviewOverride(data)"
              v-tooltip="'Klicken, um auf automatisch zurückzusetzen'"
            />
            <Tag v-else value="auto" severity="secondary" class="override-tag" />
          </div>
        </template>
      </Column>
      <Column header="" :style="{ width: '4rem', textAlign: 'right' }">
        <template #body="{ data }">
          <Button
            icon="pi pi-trash"
            severity="danger"
            text
            rounded
            aria-label="Bezugsperson entfernen"
            :loading="deletingId === data.id"
            @click="handleDelete(data)"
          />
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.subject-persons-view {
  max-width: 72rem;
  margin: 0 auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.page-header h1 {
  margin: 0 0 0.25rem;
}
.page-hint {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
  line-height: 1.4;
}
.page-hint code {
  background: rgba(0, 0, 0, 0.05);
  padding: 0.05rem 0.3rem;
  border-radius: 0.25rem;
  font-size: 0.85em;
}

.assessment-section {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  background: var(--p-content-background);
}
.assessment-section h2 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.assessment-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: flex-end;
}
.assessment-form label {
  flex: 1 1 12rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.add-form {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  background: var(--p-content-background);
}
.add-form h2 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.add-form__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: flex-end;
}
.add-form__grid label {
  flex: 1 1 12rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.add-form__grid .checkbox-label {
  flex: 0 0 auto;
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
  padding-bottom: 0.4rem;
}
.add-form__submit {
  display: flex;
  align-items: flex-end;
  padding-bottom: 0.05rem;
}
.label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.inline-select {
  min-width: 8rem;
}

.inline-year {
  max-width: 7rem;
}
.inline-year :deep(input) {
  width: 100%;
}

.tax-review-cell {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.override-tag {
  font-size: 0.7rem;
}
</style>
