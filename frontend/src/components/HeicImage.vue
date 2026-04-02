<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed, nextTick } from 'vue';

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
const imageContentWrapperRef = ref<HTMLElement | null>(null);
const imgRef = ref<HTMLImageElement | null>(null);
const slotContainerStyle = ref<Record<string, string>>({
  top: '0px',
  left: '0px',
  width: '100%',
  height: '100%',
});
let resizeObserver: ResizeObserver | null = null;

const objectFitClass = computed(() => {
  return `fit-${props.objectFit || 'cover'}`;
});

const contentWrapperStyle = computed(() => {
  const fit = props.objectFit || 'cover';
  if ((fit === 'contain' || fit === 'scale-down') && naturalAspectRatio.value) {
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
  naturalAspectRatio.value = null;

  // Strip query params before checking extension so "file.heic?w=400" is detected correctly
  const pathPart = (props.src.split('?')[0] ?? props.src).toLowerCase();
  isHeic.value = pathPart.endsWith('.heic') || pathPart.endsWith('.heif');

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
  imgRef.value = img;
  if (resizeObserver) {
    resizeObserver.observe(img);
  }
  if (img.naturalWidth && img.naturalHeight) {
    naturalAspectRatio.value = img.naturalWidth / img.naturalHeight;
  }
  updateSlotBounds();
};

const getRenderedObjectRectInImageBox = (img: HTMLImageElement) => {
  const boxWidth = img.clientWidth;
  const boxHeight = img.clientHeight;
  const naturalWidth = img.naturalWidth;
  const naturalHeight = img.naturalHeight;

  if (!boxWidth || !boxHeight || !naturalWidth || !naturalHeight) {
    return {
      x: 0,
      y: 0,
      width: boxWidth,
      height: boxHeight,
      boxWidth,
      boxHeight,
    };
  }

  const computedFit = window.getComputedStyle(img).objectFit || 'fill';
  let renderedWidth = boxWidth;
  let renderedHeight = boxHeight;

  if (computedFit === 'contain') {
    const scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    renderedWidth = naturalWidth * scale;
    renderedHeight = naturalHeight * scale;
  } else if (computedFit === 'cover') {
    const scale = Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight);
    renderedWidth = naturalWidth * scale;
    renderedHeight = naturalHeight * scale;
  } else if (computedFit === 'none') {
    renderedWidth = naturalWidth;
    renderedHeight = naturalHeight;
  } else if (computedFit === 'scale-down') {
    const containScale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    const scale = Math.min(1, containScale);
    renderedWidth = naturalWidth * scale;
    renderedHeight = naturalHeight * scale;
  }

  // Read object-position from computed style (supports inline style set via imageStyle prop)
  const computedPos = window.getComputedStyle(img).objectPosition || '50% 50%'
  const posParts = computedPos.split(' ')
  const opX = Math.max(0, Math.min(100, parseFloat(posParts[0] ?? '50') || 50)) / 100
  const opY = Math.max(0, Math.min(100, parseFloat(posParts[1] ?? posParts[0] ?? '50') || 50)) / 100

  return {
    x: (boxWidth - renderedWidth) * opX,
    y: (boxHeight - renderedHeight) * opY,
    width: renderedWidth,
    height: renderedHeight,
    boxWidth,
    boxHeight,
  };
};

const updateSlotBounds = () => {
  const wrapper = imageContentWrapperRef.value;
  const img = imgRef.value;

  if (!wrapper || !img) {
    slotContainerStyle.value = {
      top: '0px',
      left: '0px',
      width: '100%',
      height: '100%',
    };
    return;
  }

  const wrapperRect = wrapper.getBoundingClientRect();
  const imgRect = img.getBoundingClientRect();
  const renderedRectInImageBox = getRenderedObjectRectInImageBox(img);

  if (imgRect.width <= 0 || imgRect.height <= 0 || wrapperRect.width <= 0 || wrapperRect.height <= 0) {
    slotContainerStyle.value = {
      top: '0px',
      left: '0px',
      width: '100%',
      height: '100%',
    };
    return;
  }

  const scaleX = renderedRectInImageBox.boxWidth > 0
    ? imgRect.width / renderedRectInImageBox.boxWidth
    : 1;
  const scaleY = renderedRectInImageBox.boxHeight > 0
    ? imgRect.height / renderedRectInImageBox.boxHeight
    : 1;

  slotContainerStyle.value = {
    left: `${imgRect.left - wrapperRect.left + renderedRectInImageBox.x * scaleX}px`,
    top: `${imgRect.top - wrapperRect.top + renderedRectInImageBox.y * scaleY}px`,
    width: `${renderedRectInImageBox.width * scaleX}px`,
    height: `${renderedRectInImageBox.height * scaleY}px`,
  };
};

const setupResizeObserver = () => {
  if (typeof ResizeObserver === 'undefined') return;

  resizeObserver = new ResizeObserver(() => {
    updateSlotBounds();
  });

  if (imageContentWrapperRef.value) {
    resizeObserver.observe(imageContentWrapperRef.value);
  }
  if (imgRef.value) {
    resizeObserver.observe(imgRef.value);
  }
};

onMounted(checkAndConvert);
onMounted(() => {
  setupResizeObserver();
  window.addEventListener('resize', updateSlotBounds);
  void nextTick(updateSlotBounds);
});
onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  window.removeEventListener('resize', updateSlotBounds);
});
watch(() => props.src, checkAndConvert);
watch(() => props.objectFit, () => void nextTick(updateSlotBounds));
watch(() => props.imageStyle, () => void nextTick(updateSlotBounds), { deep: true });
watch(() => naturalAspectRatio.value, () => void nextTick(updateSlotBounds));
</script>

<template>
  <div class="heic-image-container">
    <div class="image-wrapper">
      <div 
        class="image-content-wrapper" 
        ref="imageContentWrapperRef"
        :class="objectFitClass"
        :style="contentWrapperStyle"
      >
        <img 
          v-if="displaySrc" 
          ref="imgRef"
          :src="displaySrc" 
          :alt="alt" 
          :loading="loading" 
          :class="['full-image', objectFitClass, { 'is-loading': isLoading }]"
          :style="imageStyle"
          @load="onImageLoad"
          @error="isLoading = false"
        />
        <div class="slot-container" :style="slotContainerStyle">
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
