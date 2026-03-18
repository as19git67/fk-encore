<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue';
import heic2any from 'heic2any';

const props = defineProps<{
  src: string;
  alt?: string;
  loading?: 'lazy' | 'eager';
  objectFit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  imageStyle?: any;
}>();

const displaySrc = ref<string>('');
const isHeic = ref(false);
const isLoading = ref(false);

const objectFitClass = computed(() => {
  return `fit-${props.objectFit || 'cover'}`;
});

const checkAndConvert = async () => {
  if (!props.src) return;

  const lowerSrc = props.src.toLowerCase();
  isHeic.value = lowerSrc.endsWith('.heic') || lowerSrc.endsWith('.heif');

  if (!isHeic.value) {
    displaySrc.value = props.src;
    return;
  }

  // Check for Safari (which supports HEIC natively)
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari) {
    displaySrc.value = props.src;
    return;
  }

  isLoading.value = true;
  try {
    const response = await fetch(props.src);
    const blob = await response.blob();
    const convertedBlob = await heic2any({
      blob,
      toType: 'image/jpeg',
      quality: 0.8
    });

    const url = URL.createObjectURL(Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob);
    displaySrc.value = url;
  } catch (err) {
    console.error('Error converting HEIC:', err);
    // Fallback to original src, maybe the browser can handle it after all or shows a broken image
    displaySrc.value = props.src;
  } finally {
    isLoading.value = false;
  }
};

onMounted(checkAndConvert);
watch(() => props.src, checkAndConvert);
</script>

<template>
  <div class="heic-image-container">
    <div class="image-wrapper">
      <img 
        v-if="displaySrc" 
        :src="displaySrc" 
        :alt="alt" 
        :loading="loading" 
        :class="['full-image', objectFitClass, { 'is-loading': isLoading }]"
        :style="imageStyle"
      />
      <slot></slot>
    </div>
    <div v-if="isLoading" class="heic-loader">
       <i class="pi pi-spin pi-spinner"></i>
    </div>
  </div>
</template>

<style scoped>
.heic-image-container {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  height: 100%;
}
.image-wrapper {
  width: 100%;
  height: 100%;
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
}
.full-image {
  width: 100%;
  height: 100%;
  display: block;
}
.fit-contain {
  object-fit: contain;
}
.fit-cover {
  object-fit: cover;
}
.fit-fill {
  object-fit: fill;
}
.fit-none {
  object-fit: none;
}
.fit-scale-down {
  object-fit: scale-down;
}
img.is-loading {
  opacity: 0.5;
}
.heic-loader {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1;
}
</style>
