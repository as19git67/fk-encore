<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
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
    <img 
      v-if="displaySrc" 
      :src="displaySrc" 
      :alt="alt" 
      :loading="loading" 
      :class="{ 'is-loading': isLoading }"
      :style="[
        { objectFit: props.objectFit || 'cover' },
        props.imageStyle
      ]"
    />
    <div v-if="isLoading" class="heic-loader">
       <i class="pi pi-spin pi-spinner"></i>
    </div>
  </div>
</template>

<style scoped>
.heic-image-container {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
}
img {
  width: 100%;
  height: 100%;
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
