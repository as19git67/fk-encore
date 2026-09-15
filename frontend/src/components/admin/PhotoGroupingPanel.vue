<script setup lang="ts">
import { ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import {
  findPhotoGroups,
  recomputeAiPicks,
  getAiPickCalibration,
  calibrateAiPickWeights,
  backfillPhotoDimensions,
  backfillFaceSharpness,
  type AiPickWeightsCalibrationResult,
} from '../../api/photos'
import { useScanQueueStatus } from '../../composables/useScanQueueStatus'

const { isActive } = useScanQueueStatus()

const groupingResult = ref<{ groups_created: number; total_photos_grouped: number } | null>(null)
const groupingLoading = ref(false)
const groupingError = ref('')

async function handleFindGroups() {
  groupingResult.value = null
  groupingError.value = ''
  groupingLoading.value = true
  try {
    groupingResult.value = await findPhotoGroups()
  } catch (err: any) {
    groupingError.value = err.message || 'Fehler beim Gruppieren'
  } finally {
    groupingLoading.value = false
  }
}

// ── KI-Auto-Pick (Track I) ────────────────────────────────────────────────────

const aiPickRecomputeResult = ref<{ groups_scored: number; groups_skipped: number } | null>(null)
const aiPickLoading = ref(false)
const aiPickError = ref('')

async function handleRecomputeAiPicks() {
  aiPickRecomputeResult.value = null
  aiPickError.value = ''
  aiPickLoading.value = true
  try {
    aiPickRecomputeResult.value = await recomputeAiPicks()
  } catch (err: any) {
    aiPickError.value = err.message || 'Fehler beim Neuberechnen der KI-Picks'
  } finally {
    aiPickLoading.value = false
  }
}

const dimensionsResult = ref<{ scanned: number; updated: number; failed: number } | null>(null)
const dimensionsLoading = ref(false)

async function handleBackfillDimensions() {
  dimensionsResult.value = null
  aiPickError.value = ''
  dimensionsLoading.value = true
  try {
    dimensionsResult.value = await backfillPhotoDimensions()
  } catch (err: any) {
    aiPickError.value = err.message || 'Fehler beim Befüllen der Bildmaße'
  } finally {
    dimensionsLoading.value = false
  }
}

// Per-face sharpness backfill (Etappe 2, docs/auto-pick-face-relevance.md).
// The endpoint works in photo batches and hands back a cursor, so a single
// click drives the whole pass here rather than making the admin click once
// per batch. Totals accumulate across batches; a failing batch stops the loop
// and keeps whatever was measured so far.
const faceSharpnessProgress = ref<{
  photos_scanned: number
  faces_updated: number
  faces_skipped: number
  photos_failed: number
  remaining_faces: number
  done: boolean
} | null>(null)
const faceSharpnessLoading = ref(false)

async function handleBackfillFaceSharpness() {
  faceSharpnessProgress.value = null
  aiPickError.value = ''
  faceSharpnessLoading.value = true
  const totals = {
    photos_scanned: 0,
    faces_updated: 0,
    faces_skipped: 0,
    photos_failed: 0,
    remaining_faces: 0,
    done: false,
  }
  try {
    let cursor: number | undefined
    for (;;) {
      const batch = await backfillFaceSharpness(cursor)
      totals.photos_scanned += batch.photos_scanned
      totals.faces_updated += batch.faces_updated
      totals.faces_skipped += batch.faces_skipped
      totals.photos_failed += batch.photos_failed
      totals.remaining_faces = batch.remaining_faces
      totals.done = batch.next_photo_id === null
      faceSharpnessProgress.value = { ...totals }
      if (batch.next_photo_id === null) break
      cursor = batch.next_photo_id
    }
  } catch (err: any) {
    aiPickError.value = err.message || 'Fehler beim Messen der Gesichtsschärfe'
  } finally {
    faceSharpnessLoading.value = false
  }
}

const calibrationLoading = ref(false)

// Browser navigating to the endpoint URL fails because Encore's auth
// handler only accepts Authorization: Bearer (see user/auth-handler.ts).
// This button fetches via apiFetch (which adds the Bearer token) and
// triggers a blob download from the JSON in memory.
async function handleDownloadCalibration() {
  calibrationLoading.value = true
  aiPickError.value = ''
  try {
    const data = await getAiPickCalibration()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-pick-calibration-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (err: any) {
    aiPickError.value = err.message || 'Fehler beim Herunterladen des Kalibrierungs-Exports'
  } finally {
    calibrationLoading.value = false
  }
}

const calibrateWeightsLoading = ref(false)
const calibrateWeightsResult = ref<AiPickWeightsCalibrationResult | null>(null)

async function handleCalibrateWeights() {
  calibrateWeightsLoading.value = true
  calibrateWeightsResult.value = null
  aiPickError.value = ''
  try {
    calibrateWeightsResult.value = await calibrateAiPickWeights()
  } catch (err: any) {
    aiPickError.value = err.message || 'Fehler beim Kalibrieren der Gewichte'
  } finally {
    calibrateWeightsLoading.value = false
  }
}

function pct(v: number | undefined | null): string {
  if (v == null) return '–'
  return `${Math.round(v * 100)} %`
}
</script>

<template>
  <div class="data-management-group">
    <h3>Ähnliche Fotos gruppieren</h3>
    <p>
      Ähnliche Fotos werden anhand der Embeddings automatisch zu Gruppen zusammengefasst.
    </p>

    <Message v-if="groupingError" severity="error" class="data-management-group__item" @close="groupingError = ''">{{ groupingError }}</Message>

    <div v-if="groupingResult" class="data-management-group__item">
      <Message severity="info" :closable="false">
        {{ groupingResult.groups_created }} neue Gruppen erstellt
        ({{ groupingResult.total_photos_grouped }} Fotos gruppiert).
      </Message>
    </div>

    <Button class="data-management-group__item"
      icon="pi pi-images"
      outlined
      label="Gruppen neu berechnen"
      :loading="groupingLoading"
      :disabled="groupingLoading || isActive"
      @click="handleFindGroups"
    />

    <!-- KI-Auto-Pick (Track I) -->
    <Message v-if="aiPickError" severity="error" class="data-management-group__item" @close="aiPickError = ''">{{ aiPickError }}</Message>
    <Message v-if="aiPickRecomputeResult" severity="info" :closable="false" class="data-management-group__item">
      {{ aiPickRecomputeResult.groups_scored }} Gruppen neu bewertet
      (übersprungen: {{ aiPickRecomputeResult.groups_skipped }}).
    </Message>
    <Button class="data-management-group__item"
      icon="pi pi-sparkles"
      outlined
      label="KI-Picks neu berechnen"
      :loading="aiPickLoading"
      :disabled="aiPickLoading || groupingLoading || isActive"
      @click="handleRecomputeAiPicks"
    />

    <Message v-if="dimensionsResult" severity="info" :closable="false" class="data-management-group__item">
      Bildmaße aktualisiert: {{ dimensionsResult.updated }} / {{ dimensionsResult.scanned }}
      (fehlgeschlagen: {{ dimensionsResult.failed }}).
    </Message>
    <Button class="data-management-group__item"
      icon="pi pi-arrows-alt"
      outlined
      label="Bildmaße nachtragen"
      v-tooltip.top="'Liest Breite und Höhe aus den Original-Dateien nach, damit die Orientierungsregel und der KI-Crop-Vorschlag korrekt arbeiten können.'"
      :loading="dimensionsLoading"
      :disabled="dimensionsLoading || aiPickLoading || groupingLoading || isActive"
      @click="handleBackfillDimensions"
    />

    <Message v-if="faceSharpnessProgress" severity="info" :closable="false" class="data-management-group__item">
      Gesichtsschärfe gemessen: {{ faceSharpnessProgress.faces_updated }} Gesichter in
      {{ faceSharpnessProgress.photos_scanned }} Fotos
      (zu klein zum Messen: {{ faceSharpnessProgress.faces_skipped }}, fehlgeschlagen:
      {{ faceSharpnessProgress.photos_failed }}).
      <span v-if="!faceSharpnessProgress.done">
        Noch offen: {{ faceSharpnessProgress.remaining_faces }} Gesichter.
      </span>
    </Message>
    <Button class="data-management-group__item"
      icon="pi pi-eye"
      outlined
      label="Gesichtsschärfe nachtragen"
      v-tooltip.top="'Misst die Schärfe jedes erkannten Gesichts direkt aus den Bilddaten (Laplace-Varianz über die Gesichtsbox) und speichert sie pro Gesicht. Grundlage für die prominenzgewichtete Auswahl in ähnlichen Gruppen.'"
      :loading="faceSharpnessLoading"
      :disabled="faceSharpnessLoading || dimensionsLoading || aiPickLoading || groupingLoading || isActive"
      @click="handleBackfillFaceSharpness"
    />

    <Button class="data-management-group__item"
      icon="pi pi-download"
      outlined
      label="Kalibrierungs-Export herunterladen"
      :loading="calibrationLoading"
      :disabled="calibrationLoading"
      @click="handleDownloadCalibration"
    />

    <!-- Stufe D: per-User Gewichts-Kalibrierung. Lernt aus den
         bereits reviewten Gruppen welche Signale dem User wichtig
         sind, persistiert das Ergebnis in ai_pick_user_weights und
         der nächste "KI-Picks neu berechnen"-Lauf nutzt automatisch
         die fittierten Gewichte. -->
    <Message v-if="calibrateWeightsResult" severity="info" :closable="false" class="data-management-group__item">
      <div><strong>Kalibrierung abgeschlossen.</strong></div>
      <div>
        Personen-Burst:
        {{ calibrateWeightsResult.metadata.pair_count_face }} Vergleichspaare,
        Trefferquote
        <strong>{{ pct(calibrateWeightsResult.metadata.top1_accuracy_face) }}</strong>
        (vorher {{ pct(calibrateWeightsResult.metadata.top1_accuracy_face_baseline) }})
      </div>
      <div>
        Nicht-Personen-Burst:
        {{ calibrateWeightsResult.metadata.pair_count_non_face }} Vergleichspaare,
        Trefferquote
        <strong>{{ pct(calibrateWeightsResult.metadata.top1_accuracy_non_face) }}</strong>
        (vorher {{ pct(calibrateWeightsResult.metadata.top1_accuracy_non_face_baseline) }})
      </div>
    </Message>
    <Button class="data-management-group__item"
      icon="pi pi-graduation-cap"
      outlined
      label="KI auf meine Vorlieben kalibrieren"
      v-tooltip.bottom="'Lernt aus den bereits reviewten Gruppen welche Signale dir wichtig sind. Danach einmal &quot;KI-Picks neu berechnen&quot; klicken.'"
      :loading="calibrateWeightsLoading"
      :disabled="calibrateWeightsLoading || aiPickLoading || groupingLoading || isActive"
      @click="handleCalibrateWeights"
    />
  </div>
</template>

<style scoped src="./adminPanels.css"></style>
