<script setup lang="ts">
import { onMounted, nextTick, ref, computed, watch } from 'vue'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
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

// Font-size presets expressed as cpi/lpi (characters/lines per inch; lower =
// larger font). These drive the canvas render — cpi sets the glyph width, lpi
// the line height. sampleRem only scales the "Aa" preview on the selector.
interface FontPreset {
  key: 'small' | 'medium' | 'large'
  label: string
  cpi: number
  lpi: number
  sampleRem: number
}
const FONT_PRESETS: FontPreset[] = [
  { key: 'small', label: 'Klein', cpi: 14, lpi: 8, sampleRem: 0.9 },
  { key: 'medium', label: 'Mittel', cpi: 10, lpi: 6, sampleRem: 1.3 },
  { key: 'large', label: 'Groß', cpi: 7, lpi: 4, sampleRem: 1.8 },
]

// DYMO LabelWriter 450 compatible labels (media width ≤ 56 mm). widthMm is the
// long edge (text line direction → centering), heightMm the short edge across
// the print head (→ how many lines fit).
interface LabelType {
  code: string
  name: string
  widthMm: number
  heightMm: number
}
const LABELS: LabelType[] = [
  { code: '99012', name: 'Adresse groß', widthMm: 89, heightMm: 36 },
  { code: '99010', name: 'Adresse standard', widthMm: 89, heightMm: 28 },
  { code: '99014', name: 'Versand', widthMm: 101, heightMm: 54 },
  { code: '11356', name: 'Namensschild', widthMm: 89, heightMm: 41 },
  { code: '11354', name: 'Vielzweck', widthMm: 57, heightMm: 32 },
  { code: '11352', name: 'Rücksendeadresse', widthMm: 54, heightMm: 25 },
  { code: '99015', name: 'Medien / Diskette', widthMm: 70, heightMm: 54 },
  { code: '11355', name: 'Vielzweck klein', widthMm: 51, heightMm: 19 },
  { code: '99017', name: 'Hängeregister', widthMm: 50, heightMm: 12 },
]

const ALIGN_OPTIONS = [
  { label: 'Links', value: 'left', icon: 'pi pi-align-left' },
  { label: 'Zentriert', value: 'center', icon: 'pi pi-align-center' },
]

const printers = ref<LabelPrinter[]>([])
const selectedPrinter = ref<string | null>(null)
const text = ref('')
const copies = ref(1)
const fontKey = ref<FontPreset['key']>('medium')
const align = ref<'left' | 'center'>('left')
const labelCode = ref<string>('99012')

const loading = ref(false)
const printing = ref(false)
const error = ref('')
const info = ref('')

const selectedFont = computed(
  () => FONT_PRESETS.find((p) => p.key === fontKey.value) ?? FONT_PRESETS[1]!,
)
const selectedLabel = computed(
  () => LABELS.find((l) => l.code === labelCode.value) ?? LABELS[0]!,
)
// DYMO LabelWriter 450 prints at 300 dpi. The DYMO_DPI constant drives the
// raster size; if other models are added it can be made configurable.
const DPI = 300
const MM_PER_INCH = 25.4

// Lines that fit ≈ printable height (short edge) × lines-per-inch.
const maxLines = computed(() =>
  Math.max(1, Math.floor((selectedLabel.value.heightMm / MM_PER_INCH) * selectedFont.value.lpi)),
)
// Characters per line ≈ printable width (long edge) × characters-per-inch.
const maxColumns = computed(() =>
  Math.max(1, Math.floor((selectedLabel.value.widthMm / MM_PER_INCH) * selectedFont.value.cpi)),
)
// Dropdown labels: "99012 · Adresse groß · 89×36 mm"
const labelOptions = computed(() =>
  LABELS.map((l) => ({
    code: l.code,
    text: `${l.code} · ${l.name} · ${l.widthMm}×${l.heightMm} mm`,
  })),
)

// Wrap text to the column width: keep explicit line breaks, wrap long lines at
// word boundaries, and hard-break a word that is itself longer than a line.
function wrapLines(input: string, columns: number): string[] {
  const out: string[] = []
  for (const paragraph of input.split('\n')) {
    let rest = paragraph
    while (rest.length > columns) {
      let breakAt = rest.lastIndexOf(' ', columns)
      if (breakAt <= 0) breakAt = columns // long word → hard break
      out.push(rest.slice(0, breakAt))
      rest = rest.slice(breakAt).replace(/^ +/, '')
    }
    out.push(rest)
  }
  return out
}

// All wrapped lines (before the height cap) — used to warn about overflow.
const wrappedLines = computed(() => wrapLines(text.value, maxColumns.value))
const overflow = computed(() => wrappedLines.value.length > maxLines.value)

const previewCanvas = ref<HTMLCanvasElement | null>(null)

/**
 * Draw the label onto `previewCanvas` at full print resolution. The same
 * canvas is exported to PNG for printing, so the preview is exactly what gets
 * printed (WYSIWYG) — and because the image is always the same pixel size for
 * a given label, the printer renders it at a consistent size regardless of how
 * much text it contains.
 */
function renderLabel() {
  const canvas = previewCanvas.value
  if (!canvas) return
  const label = selectedLabel.value
  const font = selectedFont.value

  const w = Math.round((label.widthMm / MM_PER_INCH) * DPI)
  const h = Math.round((label.heightMm / MM_PER_INCH) * DPI)
  canvas.width = w
  canvas.height = h

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  // White paper; the printer renders dark pixels as "printed".
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#000000'
  ctx.textBaseline = 'top'

  const lineHeightPx = DPI / font.lpi
  // Derive the font size so one monospace character advances exactly DPI/cpi
  // pixels — i.e. it renders at the chosen characters-per-inch, independent of
  // which monospace face the browser actually substitutes.
  const targetCharPx = DPI / font.cpi
  const BASE = 100
  ctx.font = `${BASE}px 'Courier New', Courier, monospace`
  const advance = ctx.measureText('M').width || BASE * 0.6
  const fontSizePx = (BASE * targetCharPx) / advance
  ctx.font = `${fontSizePx}px 'Courier New', Courier, monospace`

  const lines = wrappedLines.value.slice(0, maxLines.value)
  lines.forEach((line, i) => {
    const y = i * lineHeightPx + (lineHeightPx - fontSizePx) / 2
    let x = 0
    if (align.value === 'center') {
      x = Math.max(0, (w - ctx.measureText(line).width) / 2)
    }
    ctx.fillText(line, x, y)
  })
}

// Re-render whenever anything that affects the output changes.
watch([text, fontKey, align, labelCode], () => nextTick(renderLabel))

// Remember the formatting choices locally (no backend round-trip needed).
const LS_KEY = 'label_ui_prefs'
function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return
    const p = JSON.parse(raw)
    if (FONT_PRESETS.some((f) => f.key === p.fontKey)) fontKey.value = p.fontKey
    if (p.align === 'left' || p.align === 'center') align.value = p.align
    if (LABELS.some((l) => l.code === p.labelCode)) labelCode.value = p.labelCode
  } catch {
    /* ignore corrupt prefs */
  }
}
watch([fontKey, align, labelCode], () => {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ fontKey: fontKey.value, align: align.value, labelCode: labelCode.value }),
    )
  } catch {
    /* storage unavailable — non-fatal */
  }
})

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
  // Render fresh, then export the canvas exactly as previewed.
  renderLabel()
  const canvas = previewCanvas.value
  const dataUrl = canvas?.toDataURL('image/png')
  const imageBase64 = dataUrl?.split(',')[1]
  if (!imageBase64) {
    error.value = 'Vorschau konnte nicht erzeugt werden'
    return
  }
  printing.value = true
  try {
    const res = await printLabel({
      imageBase64,
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

onMounted(() => {
  loadUiPrefs()
  loadPrinters()
  nextTick(renderLabel)
})
</script>

<template>
  <div class="label-view">
    <header class="page-header">
      <h1>Label drucken</h1>
      <p class="page-hint">
        Text eingeben, Schriftgröße, Ausrichtung, Anzahl und Drucker wählen und
        auf <strong>Drucken</strong> tippen. Der Text wird an den ausgewählten
        CUPS-Drucker gesendet (z.&nbsp;B. DYMO LabelWriter&nbsp;450).
      </p>
    </header>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>

    <section class="form">
      <label class="field">
        <span class="label">Text</span>
        <Textarea
          v-model="text"
          :rows="Math.min(maxLines, 6)"
          placeholder="Text für das Label…"
          :disabled="printing"
          class="text-input"
        />
        <small class="hint-muted">
          max. {{ maxLines }} Zeilen × {{ maxColumns }} Zeichen bei dieser Schriftgröße
        </small>
        <small v-if="overflow" class="hint-warn">
          Der Text passt nicht vollständig auf das Etikett und wird abgeschnitten.
        </small>
      </label>

      <div class="field">
        <span class="label">Vorschau</span>
        <div class="preview">
          <canvas ref="previewCanvas" class="preview__canvas" />
        </div>
        <small class="hint-muted">
          So wird gedruckt — {{ selectedLabel.widthMm }}×{{ selectedLabel.heightMm }} mm bei
          {{ DPI }} dpi.
        </small>
      </div>

      <label class="field">
        <span class="label">Etikett</span>
        <Select
          v-model="labelCode"
          :options="labelOptions"
          option-label="text"
          option-value="code"
          :disabled="printing"
        />
      </label>

      <div class="field-row">
        <div class="field field--font">
          <span class="label">Schriftgröße</span>
          <SelectButton
            v-model="fontKey"
            :options="FONT_PRESETS"
            option-label="label"
            option-value="key"
            :allow-empty="false"
            :disabled="printing"
            aria-label="Schriftgröße"
          >
            <template #option="{ option }">
              <span class="font-sample">
                <span :style="{ fontSize: option.sampleRem + 'rem' }">Aa</span>
                <small>{{ option.label }}</small>
              </span>
            </template>
          </SelectButton>
        </div>

        <div class="field field--align">
          <span class="label">Ausrichtung</span>
          <SelectButton
            v-model="align"
            :options="ALIGN_OPTIONS"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            :disabled="printing"
            aria-label="Ausrichtung"
          >
            <template #option="{ option }">
              <i :class="option.icon" aria-hidden="true" />
              <span class="align-label">{{ option.label }}</span>
            </template>
          </SelectButton>
        </div>
      </div>

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

      <p v-if="!loading && !error && printers.length === 0" class="hint-muted">
        Der CUPS-Server ist erreichbar, meldet aber keine Drucker. Prüfe, ob auf
        diesem Server eine Drucker-Warteschlange existiert (z.&nbsp;B. unter
        <code>/printers/</code> der CUPS-Weboberfläche).
      </p>

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
.field--font,
.field--align {
  flex: 1 1 auto;
}

/* "Aa" sample on the font-size selector, scaled per preset. */
.font-sample {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.1rem;
  line-height: 1;
  min-width: 2.5rem;
}
.font-sample small {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
.align-label {
  margin-left: 0.4rem;
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

.text-input {
  font-family: 'Courier New', Courier, monospace;
}

/* Live WYSIWYG preview: the canvas is rendered at full print resolution and
   scaled down to fit; its intrinsic pixel ratio preserves the label aspect. */
.preview {
  display: flex;
  justify-content: center;
  padding: 0.5rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  background: var(--p-content-hover-background);
}
.preview__canvas {
  display: block;
  width: 100%;
  height: auto;
  background: #fff;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.25rem;
}

.hint-muted {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.hint-warn {
  margin: 0;
  color: var(--p-message-warn-color, #b45309);
  font-size: 0.85rem;
}
.hint-muted code {
  background: rgba(0, 0, 0, 0.05);
  padding: 0.05rem 0.3rem;
  border-radius: 0.25rem;
}
</style>
