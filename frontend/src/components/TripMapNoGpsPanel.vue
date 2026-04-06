<script lang="ts" setup>
import { ref } from 'vue'
import type { Photo } from '../api/photos'
import { getPhotoUrl } from '../api/photos'

defineProps<{
  photos: Photo[]
}>()

const emit = defineEmits<{
  'photo-click': [photo: Photo]
}>()

const expanded = ref(false)
</script>

<template>
  <div class="no-gps-panel" :class="{ expanded }">
    <button class="no-gps-toggle" @click="expanded = !expanded">
      <i :class="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-up'" />
      <span>{{ photos.length }} {{ photos.length === 1 ? 'Foto' : 'Fotos' }} ohne GPS-Daten</span>
    </button>

    <div v-if="expanded" class="no-gps-strip">
      <div
        v-for="photo in photos"
        :key="photo.id"
        class="no-gps-thumb"
        @click="emit('photo-click', photo)"
      >
        <img
          :src="getPhotoUrl(photo.filename, 120)"
          :alt="photo.original_name"
          loading="lazy"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.no-gps-panel {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(8px);
  z-index: 1000;
  border-top: 1px solid rgba(255, 255, 255, 0.15);
}

.no-gps-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 16px;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.8);
  font-size: 0.85rem;
  cursor: pointer;
  transition: color 0.15s;
}

.no-gps-toggle:hover {
  color: white;
}

.no-gps-strip {
  display: flex;
  gap: 6px;
  padding: 0 16px 10px;
  overflow-x: auto;
  scrollbar-width: thin;
}

.no-gps-thumb {
  flex-shrink: 0;
  width: 64px;
  height: 64px;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  transition: border-color 0.15s, transform 0.15s;
}

.no-gps-thumb:hover {
  border-color: var(--p-primary-color, #4285F4);
  transform: scale(1.05);
}

.no-gps-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
