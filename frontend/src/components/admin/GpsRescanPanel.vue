<script setup lang="ts">
import { ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import { getPhotosNeedingGpsRescan, rescanPhotoGps } from '../../api/photos'
import { useScanQueueStatus } from '../../composables/useScanQueueStatus'

const { isActive } = useScanQueueStatus()

const gpsRescanLoading = ref(false)
const gpsRescanProgress = ref(0)
const gpsRescanCurrent = ref(0)
const gpsRescanTotal = ref(0)
const gpsRescanResult = ref<{ gpsFound: number; geocoded: number; scansQueued: number } | null>(null)
const gpsRescanError = ref('')

async function handleGpsRescan() {
  if (gpsRescanLoading.value) return
  gpsRescanLoading.value = true
  gpsRescanProgress.value = 0
  gpsRescanCurrent.value = 0
  gpsRescanTotal.value = 0
  gpsRescanResult.value = null
  gpsRescanError.value = ''
  try {
    const { ids } = await getPhotosNeedingGpsRescan()
    if (ids.length === 0) {
      gpsRescanResult.value = { gpsFound: 0, geocoded: 0, scansQueued: 0 }
      return
    }
    gpsRescanTotal.value = ids.length
    let gpsFound = 0, geocoded = 0, scansQueued = 0
    for (const id of ids) {
      try {
        const res = await rescanPhotoGps(id)
        if (res.gpsFound) gpsFound++
        if (res.geocoded) geocoded++
        if (res.scansQueued) scansQueued++
      } catch { /* skip individual failures */ }
      gpsRescanCurrent.value++
      gpsRescanProgress.value = Math.round((gpsRescanCurrent.value / gpsRescanTotal.value) * 100)
      // Respect Nominatim rate limit (1 req/s)
      if (gpsRescanCurrent.value < ids.length) await new Promise(r => setTimeout(r, 1100))
    }
    gpsRescanResult.value = { gpsFound, geocoded, scansQueued }
  } catch (err: any) {
    gpsRescanError.value = err.message || 'Fehler beim GPS-Rescan'
  } finally {
    gpsRescanLoading.value = false
  }
}
</script>

<template>
  <div class="data-management-group">
    <h3>GPS-Koordinaten neu einlesen</h3>
    <p>
      Liest GPS-Daten aus Fotos neu ein, bei denen die Extraktion beim Upload fehlgeschlagen ist,
      und wiederholt das Reverse-Geocoding für Fotos ohne Ortsbezeichnung.
      Wenn GPS-Koordinaten neu gefunden werden, werden alle anderen Scans (Embeddings,
      Gesichtserkennung, Qualität) ebenfalls neu gestartet.
    </p>

    <Message v-if="gpsRescanError" severity="error" class="data-management-group__item" @close="gpsRescanError = ''">{{ gpsRescanError }}</Message>

    <div v-if="gpsRescanResult" class="data-management-group__item">
      <Message severity="info" :closable="false">
        {{ gpsRescanResult.gpsFound }} Fotos mit neuen GPS-Koordinaten ·
        {{ gpsRescanResult.geocoded }} Fotos geocodiert ·
        {{ gpsRescanResult.scansQueued }} Fotos neu in die Scan-Queue eingereiht
      </Message>
    </div>

    <div v-if="gpsRescanLoading" class="data-management-group__item">
      <span class="text-secondary">GPS wird verarbeitet… {{ gpsRescanCurrent }} / {{ gpsRescanTotal }}</span>
      <ProgressBar :value="gpsRescanProgress" :showValue="false" style="margin-top:0.5rem" />
    </div>

    <Button class="data-management-group__item"
      icon="pi pi-map-marker"
      outlined
      label="GPS neu einlesen"
      :disabled="gpsRescanLoading || isActive"
      :loading="gpsRescanLoading"
      @click="handleGpsRescan"
    />
  </div>
</template>

<style scoped src="./adminPanels.css"></style>
