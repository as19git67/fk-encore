<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { API_BASE_URL } from '../api/client'

const props = defineProps<{
  id: number
  alt?: string
}>()

const blobSrc = ref<string | null>(null)
const failed = ref(false)
let abortCtrl: AbortController | null = null

async function loadThumb(id: number) {
  abortCtrl?.abort()
  blobSrc.value = null
  failed.value = false

  const token = localStorage.getItem('auth_token')
  const ctrl = new AbortController()
  abortCtrl = ctrl

  try {
    const res = await fetch(`${API_BASE_URL}/documents/${id}/thumbnail`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    })
    if (!res.ok) { failed.value = true; return }
    const blob = await res.blob()
    if (ctrl.signal.aborted) return
    blobSrc.value = URL.createObjectURL(blob)
  } catch {
    if (!ctrl.signal.aborted) failed.value = true
  }
}

function revoke() {
  if (blobSrc.value) {
    URL.revokeObjectURL(blobSrc.value)
    blobSrc.value = null
  }
}

watch(() => props.id, (id) => {
  revoke()
  loadThumb(id)
}, { immediate: true })

onBeforeUnmount(() => {
  abortCtrl?.abort()
  revoke()
})
</script>

<template>
  <div class="doc-thumb" :class="{ 'doc-thumb--placeholder': failed }">
    <img
      v-if="blobSrc"
      :src="blobSrc"
      :alt="alt || 'Dokumentvorschau'"
      class="doc-thumb-img"
    />
    <i v-else class="pi pi-file-pdf doc-thumb-fallback" />
  </div>
</template>

<style scoped>
.doc-thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 6px;
  background: var(--p-content-hover-background);
}
.doc-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top center;
}
.doc-thumb-fallback {
  font-size: 2.5rem;
  color: var(--p-text-muted-color);
}
</style>
