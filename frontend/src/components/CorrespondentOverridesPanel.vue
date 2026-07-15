<script setup lang="ts">
import { onMounted, ref } from 'vue'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import {
  listCorrespondentOverrides,
  createCorrespondentOverride,
  deleteCorrespondentOverride,
  type CorrespondentOverride,
} from '../api/documents'

const items = ref<CorrespondentOverride[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const info = ref('')

const pattern = ref('')
const display = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await listCorrespondentOverrides()
    items.value = res.items
  } catch (err: any) {
    error.value = err?.message || 'Overrides konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

async function add() {
  if (saving.value) return
  const p = pattern.value.trim()
  const d = display.value.trim()
  if (p.length === 0 || d.length === 0) {
    error.value = 'Absender-Muster und Korrespondent dürfen nicht leer sein.'
    return
  }
  saving.value = true
  error.value = ''
  info.value = ''
  try {
    await createCorrespondentOverride({ sender_pattern: p, correspondent_display: d })
    pattern.value = ''
    display.value = ''
    info.value = 'Override gespeichert. Wird beim nächsten „Dateipfade aktualisieren" angewendet.'
    await load()
  } catch (err: any) {
    error.value = err?.message || 'Override konnte nicht gespeichert werden.'
  } finally {
    saving.value = false
  }
}

async function remove(id: number) {
  error.value = ''
  info.value = ''
  try {
    await deleteCorrespondentOverride(id)
    await load()
  } catch (err: any) {
    error.value = err?.message || 'Override konnte nicht gelöscht werden.'
  }
}

onMounted(load)
</script>

<template>
  <div class="correspondent-overrides">
    <h3>Korrespondenten-Overrides</h3>
    <p class="hint">
      Erzwingt für Dokumente, deren Absender das Muster enthält, einen bestimmten
      Korrespondenten (überschreibt die eingebaute Zuordnung). Greift, sobald ein
      Dokument neu abgelegt wird — z. B. über „Dateipfade aktualisieren". Bei
      mehreren Treffern gewinnt das längste und damit spezifischste Muster.
    </p>

    <div class="add-row">
      <InputText v-model="pattern" placeholder="Absender-Muster (z. B. janitos)" />
      <InputText v-model="display" placeholder="Korrespondent (z. B. Janitos)" />
      <Button label="Hinzufügen" icon="pi pi-plus" :loading="saving" @click="add" />
    </div>

    <p v-if="error" class="msg error">{{ error }}</p>
    <p v-if="info" class="msg info">{{ info }}</p>

    <div v-if="loading" class="hint"><i class="pi pi-spin pi-spinner" /> Laden…</div>
    <table v-else-if="items.length > 0" class="ovr-table">
      <thead>
        <tr><th>Absender-Muster</th><th>Korrespondent</th><th>Slug</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="o in items" :key="o.id">
          <td><code>{{ o.sender_pattern }}</code></td>
          <td>{{ o.correspondent_display }}</td>
          <td><code>{{ o.correspondent_slug }}</code></td>
          <td class="right">
            <Button
              icon="pi pi-trash"
              text
              severity="danger"
              aria-label="Override löschen"
              @click="remove(o.id)"
            />
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="hint">Noch keine Overrides angelegt.</p>
  </div>
</template>

<style scoped>
.correspondent-overrides {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.hint {
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
  margin: 0;
}
.add-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}
.add-row :deep(input) {
  min-width: 12rem;
}
.msg {
  margin: 0;
  font-size: 0.9rem;
}
.msg.error {
  color: var(--p-red-500, #ef4444);
}
.msg.info {
  color: var(--p-text-muted-color);
}
.ovr-table {
  border-collapse: collapse;
  width: 100%;
}
.ovr-table th,
.ovr-table td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.ovr-table td.right {
  text-align: right;
}
</style>
