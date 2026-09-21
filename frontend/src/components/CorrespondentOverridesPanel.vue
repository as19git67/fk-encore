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
    <template v-else-if="items.length > 0">
      <!-- Tabelle (Desktop) -->
      <table class="ovr-table">
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

      <!-- Karten (Mobil) — dieselben Felder untereinander statt vier Spalten,
           die sonst breiter werden als der Bildschirm. -->
      <ul class="ovr-cards">
        <li v-for="o in items" :key="o.id" class="ovr-card">
          <div class="ovr-card__main">
            <div class="ovr-card__field">
              <span class="ovr-card__label">Absender-Muster</span>
              <code>{{ o.sender_pattern }}</code>
            </div>
            <div class="ovr-card__field">
              <span class="ovr-card__label">Korrespondent</span>
              <span>{{ o.correspondent_display }}</span>
            </div>
            <div class="ovr-card__field">
              <span class="ovr-card__label">Slug</span>
              <code>{{ o.correspondent_slug }}</code>
            </div>
          </div>
          <Button
            icon="pi pi-trash"
            text
            severity="danger"
            aria-label="Override löschen"
            @click="remove(o.id)"
          />
        </li>
      </ul>
    </template>
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
  font-size: var(--text-base);
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
  font-size: var(--text-base);
}
.msg.error {
  color: var(--p-red-500);
}
.msg.info {
  color: var(--p-text-muted-color);
}
.ovr-table {
  border-collapse: collapse;
  width: 100%;
  table-layout: fixed;
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
/* The action column only ever holds one icon button. */
.ovr-table th:last-child,
.ovr-table td.right {
  width: 3rem;
}
/* A pattern or slug is one unbroken token, so without this the fixed layout
   still lets a long one push the table past the viewport. */
.ovr-table code,
.ovr-card code {
  overflow-wrap: anywhere;
}

/* Desktop shows the table, mobile the cards. */
.ovr-cards { display: none; }

@media (max-width: 600px) {
  .ovr-table { display: none; }

  .ovr-cards {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .ovr-card {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
  }
  .ovr-card__main {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    /* Without this a long value keeps the flex item from ever shrinking. */
    min-width: 0;
    flex: 1;
  }
  .ovr-card__field {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    font-size: var(--text-base);
  }
  .ovr-card__label {
    font-size: var(--text-sm);
    text-transform: uppercase;
    color: var(--p-text-muted-color);
  }

  /* Stack the add form so two side-by-side inputs cannot overflow either. */
  .add-row {
    flex-direction: column;
    align-items: stretch;
  }
  .add-row :deep(input) {
    min-width: 0;
    width: 100%;
  }
}
</style>
