<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue';

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
const naturalAspectRatio = ref<number | null>(null);

const objectFitClass = computed(() => {
  return `fit-${props.objectFit || 'cover'}`;
});

const contentWrapperStyle = computed(() => {
  const fit = props.objectFit || 'cover';
  if (fit === 'contain' && naturalAspectRatio.value) {
    return {
      aspectRatio: `${naturalAspectRatio.value}`,
      maxWidth: '100%',
      maxHeight: '100%',
      width: '100%',
      height: 'auto',
    };
  }
  // For other modes, we keep the default 100% x 100%
  return {
    width: '100%',
    height: '100%',
  };
});

const checkAndConvert = async () => {
  if (!props.src) return;

  const lowerSrc = props.src.toLowerCase();
  isHeic.value = lowerSrc.endsWith('.heic') || lowerSrc.endsWith('.heif');

  if (!isHeic.value) {
    displaySrc.value = props.src;
    isLoading.value = true;
    return;
  }

  // Check for Safari (which supports HEIC natively)
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari) {
    displaySrc.value = props.src;
    isLoading.value = true;
    return;
  }

  // Request converted version from server
  const separator = props.src.includes('?') ? '&' : '?';
  displaySrc.value = `${props.src}${separator}convert=true`;
  isLoading.value = true;
};

const onImageLoad = (event: Event) => {
  isLoading.value = false;
  const img = event.target as HTMLImageElement;
  if (img.naturalWidth && img.naturalHeight) {
    naturalAspectRatio.value = img.naturalWidth / img.naturalHeight;
  }
};

onMounted(checkAndConvert);
watch(() => props.src, checkAndConvert);
</script>

<template>
  <div class="heic-image-container">
    <div class="image-wrapper">
      <div 
        class="image-content-wrapper" 
        :class="objectFitClass"
        :style="contentWrapperStyle"
      >
        <img 
          v-if="displaySrc" 
          :src="displaySrc" 
          :alt="alt" 
          :loading="loading" 
          :class="['full-image', objectFitClass, { 'is-loading': isLoading }]"
          :style="imageStyle"
          @load="onImageLoad"
          @error="isLoading = false"
        />
        <div class="slot-container">
          <slot></slot>
        </div>
      </div>
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
.image-content-wrapper {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
}
.slot-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
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
