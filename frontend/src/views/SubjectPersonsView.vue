<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Tag from 'primevue/tag'
import {
  createSubjectPerson,
  deleteSubjectPerson,
  listSubjectPersons,
  type SubjectPerson,
} from '../api/documents'

const persons = ref<SubjectPerson[]>([])
const loading = ref(false)
const error = ref('')
const info = ref('')

const form = ref({ full_name: '', relation_tag: '' })
const adding = ref(false)
const deletingId = ref<number | null>(null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await listSubjectPersons()
    persons.value = res.items
  } catch (err: any) {
    error.value = err.message || 'Bezugspersonen konnten nicht geladen werden'
  } finally {
    loading.value = false
  }
}

async function handleAdd() {
  const full_name = form.value.full_name.trim()
  const relation_tag = form.value.relation_tag.trim()
  if (!full_name || !relation_tag) return
  adding.value = true
  error.value = ''
  info.value = ''
  try {
    const created = await createSubjectPerson({ full_name, relation_tag })
    persons.value = [...persons.value, created].sort((a, b) =>
      a.full_name.localeCompare(b.full_name, 'de'),
    )
    form.value.full_name = ''
    form.value.relation_tag = ''
    info.value = `${created.full_name} hinzugefügt`
  } catch (err: any) {
    error.value = err.message || 'Speichern fehlgeschlagen'
  } finally {
    adding.value = false
  }
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
      <h1>Bezugspersonen</h1>
      <p class="page-hint">
        Wenn der Klassifizierer auf einem Dokument einen dieser Namen erkennt,
        ergänzt er automatisch das hinterlegte Beziehungs-Tag (z.&nbsp;B.
        <code>mutter</code>) — und die Volltext- und Semantik-Suche finden das
        Dokument anschließend über das Tag.
      </p>
    </header>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>

    <section class="add-form" aria-labelledby="add-heading">
      <h2 id="add-heading">Bezugsperson hinzufügen</h2>
      <form class="add-form__row" @submit.prevent="handleAdd">
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
        <Button
          type="submit"
          label="Hinzufügen"
          icon="pi pi-plus"
          :loading="adding"
          :disabled="!form.full_name.trim() || !form.relation_tag.trim()"
        />
      </form>
    </section>

    <DataTable
      :value="persons"
      :loading="loading"
      data-key="id"
      empty-message="Noch keine Bezugspersonen hinterlegt."
      class="persons-table"
    >
      <Column field="full_name" header="Name" />
      <Column header="Tag">
        <template #body="{ data }">
          <Tag :value="data.relation_tag" severity="info" />
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
  max-width: 56rem;
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
.add-form__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: flex-end;
}
.add-form__row label {
  flex: 1 1 12rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
</style>
