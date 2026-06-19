<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import Message from 'primevue/message'
import { useAuthStore } from '../stores/auth'
import {
  listLabelPrinters,
  saveLabelPrinter,
  printLabel,
  type LabelPrinter,
} from '../api/label'

const auth = useAuthStore()
const canPrint = auth.hasPermission('label.print')

const printers = ref<LabelPrinter[]>([])
const selectedPrinter = ref<string | null>(null)
const text = ref('')
const copies = ref(1)

const loading = ref(false)
const printing = ref(false)
const error = ref('')
const info = ref('')

async function loadPrinters() {
  loading.value = true
  error.value = ''
  try {
    const res = await listLabelPrinters()
    printers.value = res.printers
    // Keep the saved selection if it's still available; otherwise fall
    // back to the first printer so the dropdown isn't empty.
    if (res.selected && res.printers.some((p) => p.name === res.selected)) {
      selectedPrinter.value = res.selected
    } else if (res.printers.length > 0) {
      selectedPrinter.value = res.printers[0]!.name
    } else {
      selectedPrinter.value = res.selected
    }
    if (res.cupsError) {
      error.value = `CUPS-Server: ${res.cupsError}`
    }
  } catch (err: any) {
    error.value = err.message || 'Drucker konnten nicht geladen werden'
  } finally {
    loading.value = false
  }
}

async function handlePrinterChange() {
  if (!selectedPrinter.value) return
  try {
    await saveLabelPrinter(selectedPrinter.value)
  } catch (err: any) {
    error.value = err.message || 'Druckerauswahl konnte nicht gespeichert werden'
  }
}

async function handlePrint() {
  error.value = ''
  info.value = ''
  if (!text.value.trim()) {
    error.value = 'Bitte einen Text eingeben'
    return
  }
  if (!selectedPrinter.value) {
    error.value = 'Bitte einen Drucker auswählen'
    return
  }
  printing.value = true
  try {
    const res = await printLabel({
      text: text.value,
      copies: copies.value || 1,
      printer: selectedPrinter.value,
    })
    info.value =
      res.printed > 1
        ? `${res.printed} Labels an „${res.printer}" gesendet`
        : `Label an „${res.printer}" gesendet`
  } catch (err: any) {
    error.value = err.message || 'Druck fehlgeschlagen'
  } finally {
    printing.value = false
  }
}

onMounted(loadPrinters)
</script>

<template>
  <div class="label-view">
    <header class="page-header">
      <h1>Label drucken</h1>
      <p class="page-hint">
        Text eingeben, Anzahl und Drucker wählen und auf <strong>Drucken</strong>
        tippen. Der Text wird an den ausgewählten CUPS-Drucker gesendet
        (z.&nbsp;B. DYMO LabelWriter&nbsp;450).
      </p>
    </header>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>

    <section class="form">
      <label class="field">
        <span class="label">Text</span>
        <Textarea
          v-model="text"
          :rows="5"
          auto-resize
          placeholder="Text für das Label…"
          :disabled="printing"
        />
      </label>

      <div class="field-row">
        <label class="field field--count">
          <span class="label">Anzahl</span>
          <InputNumber
            v-model="copies"
            :min="1"
            :max="50"
            show-buttons
            :disabled="printing"
          />
        </label>

        <label class="field field--printer">
          <span class="label">Drucker</span>
          <Select
            v-model="selectedPrinter"
            :options="printers"
            option-label="name"
            option-value="name"
            :loading="loading"
            placeholder="Drucker auswählen"
            :disabled="printing || printers.length === 0"
            @change="handlePrinterChange"
          >
            <template #option="{ option }">
              <div class="printer-option">
                <span class="printer-option__name">{{ option.name }}</span>
                <span class="printer-option__state">{{ option.stateLabel }}</span>
              </div>
            </template>
          </Select>
        </label>
      </div>

      <div class="actions">
        <Button
          icon="pi pi-refresh"
          label="Drucker aktualisieren"
          severity="secondary"
          outlined
          :loading="loading"
          @click="loadPrinters"
        />
        <Button
          icon="pi pi-print"
          label="Drucken"
          :loading="printing"
          :disabled="!canPrint || !text.trim() || !selectedPrinter"
          @click="handlePrint"
        />
      </div>

      <p v-if="!canPrint" class="hint-muted">
        Dir fehlt die Berechtigung <code>label.print</code> zum Drucken.
      </p>
    </section>
  </div>
</template>

<style scoped>
.label-view {
  max-width: 40rem;
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

.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 1rem;
  background: var(--p-content-background);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.field :deep(.p-textarea),
.field :deep(.p-select),
.field :deep(.p-inputnumber) {
  width: 100%;
}

.label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}
.field--count {
  flex: 0 0 10rem;
}
.field--printer {
  flex: 1 1 16rem;
  min-width: 0;
}

.printer-option {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  width: 100%;
}
.printer-option__state {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: flex-end;
}

.hint-muted {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.hint-muted code {
  background: rgba(0, 0, 0, 0.05);
  padding: 0.05rem 0.3rem;
  border-radius: 0.25rem;
}
</style>
