<script setup lang="ts">
import { ref } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import { recomputeTransformSuggestions } from '../../api/photos'
import { useScanQueueStatus } from '../../composables/useScanQueueStatus'

const { isActive } = useScanQueueStatus()

const transformSuggestLoading = ref(false)
const transformSuggestResult = ref<{
  updated: number
  failed: number
  skipped: number
  total: number
} | null>(null)
const transformSuggestError = ref('')
const transformSuggestForce = ref(false)

async function handleRecomputeTransformSuggestions() {
  transformSuggestResult.value = null
  transformSuggestError.value = ''
  transformSuggestLoading.value = true
  try {
    transformSuggestResult.value = await recomputeTransformSuggestions({
      force: transformSuggestForce.value,
    })
  } catch (err: any) {
    transformSuggestError.value =
      err.message || 'Fehler beim Berechnen der KI-Crop-Vorschläge'
  } finally {
    transformSuggestLoading.value = false
  }
}
</script>

<template>
  <div class="data-management-group">
    <h3>KI-Crop-Vorschläge neu berechnen</h3>
    <p>
      Erzeugt für jedes Foto Crop-Vorschläge in allen Seitenverhältnissen (1:1, 4:5,
      16:9, …) plus eine Belichtungs-Empfehlung. Diese Daten füllen den
      <em>„KI-Vorschlag“-Block</em> im Foto-Editor (Sliders-Icon). Die Vorschläge
      sind <strong>userübergreifend</strong> — einmal angestoßen profitieren alle
      Nutzer. Für neu hochgeladene Fotos passiert das automatisch beim Indexieren;
      diese Aktion ist nur nötig, um bestehende Fotos nachzuziehen oder nach einem
      Modell-Update.
    </p>
    <p>
      Standardmäßig werden nur Fotos berechnet, die <em>noch keine</em> Vorschlags-Zeile
      haben — Re-Runs nach einem abgebrochenen Lauf sind so günstig. Aktiviere
      „Auch bestehende neu berechnen“ nach einem Modell-Update.
    </p>

    <Message v-if="transformSuggestError" severity="error" class="data-management-group__item" @close="transformSuggestError = ''">
      {{ transformSuggestError }}
    </Message>

    <div v-if="transformSuggestResult" class="data-management-group__item">
      <Message severity="info" :closable="false">
        {{ transformSuggestResult.updated }} neu berechnet,
        {{ transformSuggestResult.skipped }} übersprungen<span v-if="transformSuggestResult.failed > 0">,
          {{ transformSuggestResult.failed }} fehlgeschlagen (fehlende Maße oder
          unlesbares Bild)</span> — gesamt {{ transformSuggestResult.total }} Fotos.
      </Message>
    </div>

    <div class="data-management-group__item force-toggle">
      <Checkbox
        v-model="transformSuggestForce"
        inputId="transform-suggest-force"
        binary
        :disabled="transformSuggestLoading"
      />
      <label for="transform-suggest-force">Auch bestehende neu berechnen</label>
    </div>

    <Button class="data-management-group__item"
      icon="pi pi-sparkles"
      outlined
      label="KI-Crop-Vorschläge neu berechnen"
      :loading="transformSuggestLoading"
      :disabled="transformSuggestLoading || isActive"
      @click="handleRecomputeTransformSuggestions"
    />
  </div>
</template>

<style scoped src="./adminPanels.css"></style>
