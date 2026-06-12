<script setup lang="ts">
import { ref, watch } from 'vue'
import { getDocumentThumbnailUrl } from '../api/documents'

const props = defineProps<{
  id: number
  alt?: string
}>()

// Falls back to a generic PDF icon when the preview hasn't been
// rendered yet (document still processing, or imported before the
// thumbnail cache existed) or the request fails.
const failed = ref(false)
const loaded = ref(false)

watch(
  () => props.id,
  () => {
    failed.value = false
    loaded.value = false
  },
)
</script>

<template>
  <div class="doc-thumb" :class="{ 'doc-thumb--placeholder': failed }">
    <img
      v-if="!failed"
      :src="getDocumentThumbnailUrl(id)"
      :alt="alt || 'Dokumentvorschau'"
      loading="lazy"
      decoding="async"
      class="doc-thumb-img"
      :class="{ 'doc-thumb-img--loaded': loaded }"
      @load="loaded = true"
      @error="failed = true"
    />
    <i v-if="failed || !loaded" class="pi pi-file-pdf doc-thumb-fallback" />
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
  opacity: 0;
  transition: opacity 0.2s ease;
}
.doc-thumb-img--loaded {
  opacity: 1;
}
.doc-thumb-fallback {
  position: absolute;
  font-size: 2.5rem;
  color: var(--p-text-muted-color);
}
</style>
