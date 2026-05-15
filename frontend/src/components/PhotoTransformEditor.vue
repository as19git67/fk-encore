<script setup lang="ts">
/**
 * Editor dialog for the per-user photo transform. Phase 5 of the AI
 * photo-transforms feature.
 *
 * Loads { mine, others, suggestion } from the backend, lets the user pick
 * an aspect ratio + adjust exposure / contrast / gamma + adopt another
 * user's recipe or materialise the AI suggestion. Live preview applies
 * the recipe via the CSS / SVG filter helpers in
 * utils/photoTransformRecipe — no server round-trip per slider tick.
 *
 * Cropper interactivity (drag the rectangle, drag handles) is deferred
 * to Phase 5b. For now the aspect-ratio picker either snaps to the AI
 * suggestion's crop for that ratio (when present) or falls back to a
 * centred crop of the chosen aspect.
 */
import { computed, onMounted, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Slider from 'primevue/slider'
import Message from 'primevue/message'
import { getPhotoUrl } from '../api/photos'
import {
  adoptPhotoTransform,
  computePhotoAutoLevels,
  deletePhotoTransform,
  getPhotoTransforms,
  materializePhotoTransform,
  upsertPhotoTransform,
  type PhotoTransformAspectRatio,
  type PhotoTransformCrop,
  type PhotoTransformOther,
  type PhotoTransformRow,
  type PhotoTransformsBundle,
} from '../api/photoTransforms'
import {
  buildRecipeSvgFilter,
  recipeToCssFilter,
  recipeToCssTransform,
  type PhotoTransformRecipe,
} from '../utils/photoTransformRecipe'
import PhotoCropper from './PhotoCropper.vue'

const props = defineProps<{
  /** Open / close state — use v-model:visible. */
  visible: boolean
  /** Photo to edit. */
  photoId: number
  /** Filename for /photos/file/<name>. */
  photoFilename: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'saved', row: PhotoTransformRow): void
  (e: 'deleted'): void
}>()

// ----------------- State -----------------

const bundle = ref<PhotoTransformsBundle | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

const recipe = ref<PhotoTransformRecipe>({
  crop: null,
  rotation: 0,
  exposure: 0,
  contrast: 0,
  gamma: 1,
  white_point: null,
  black_point: null,
})

const selectedRatio = ref<PhotoTransformAspectRatio | 'free'>('free')

const naturalWidth = ref<number>(0)
const naturalHeight = ref<number>(0)

/** Before/After toggle: when true the preview shows the un-transformed
 *  original (the recipe is kept in state and re-applied on release). */
const showOriginal = ref(false)

/** Auto-Levels button spinner state. */
const computingAutoLevels = ref(false)

const ratioOptions: { key: PhotoTransformAspectRatio; label: string }[] = [
  { key: '1:1', label: '1:1' },
  { key: '4:5', label: '4:5' },
  { key: '5:4', label: '5:4' },
  { key: '3:4', label: '3:4' },
  { key: '4:3', label: '4:3' },
  { key: '16:9', label: '16:9' },
  { key: '9:16', label: '9:16' },
]

// ----------------- Derived -----------------

const svgFilterId = computed(() => `photo-recipe-${props.photoId}`)
const svgFilterMarkup = computed(() =>
  buildRecipeSvgFilter(svgFilterId.value, recipe.value),
)
const cssFilter = computed(() =>
  recipeToCssFilter(recipe.value, svgFilterId.value),
)
const cssTransform = computed(() => recipeToCssTransform(recipe.value))

const imageAspect = computed(() => {
  if (!naturalWidth.value || !naturalHeight.value) return 1
  return naturalWidth.value / naturalHeight.value
})

// Effective crop used by the cropper. We always pass a crop in so the
// user has a rectangle to drag; if the user hasn't set one yet we show
// the full image as the "starting" crop. When the user holds the
// Before/After toggle the cropper jumps to "no crop" so the full
// untouched image is visible — recipe state is preserved and restored
// on release.
const effectiveCrop = computed(() => {
  if (showOriginal.value) return { x: 0, y: 0, w: 1, h: 1 }
  return recipe.value.crop ?? { x: 0, y: 0, w: 1, h: 1 }
})

// Crop aspect ratio passed to the cropper as a lock. null = free.
// While the Before/After toggle is engaged we relax the lock so the
// rectangle covers the entire image cleanly.
const cropAspectRatio = computed<number | null>(() => {
  if (showOriginal.value) return null
  if (selectedRatio.value === 'free') return null
  return aspectRatioToFloat(selectedRatio.value)
})

const cropperImgStyle = computed(() => {
  if (showOriginal.value) return {}
  return {
    filter: cssFilter.value || undefined,
    transform: cssTransform.value || undefined,
  }
})

const originalUrl = computed(() => getPhotoUrl(props.photoFilename))

const hasSuggestionForRatio = computed(() => {
  if (selectedRatio.value === 'free') return false
  const s = bundle.value?.suggestion
  if (!s) return false
  return Boolean(s.crops[selectedRatio.value])
})

const sortedOthers = computed<PhotoTransformOther[]>(() =>
  (bundle.value?.others ?? []).slice().sort((a, b) =>
    a.user.name.localeCompare(b.user.name),
  ),
)

// ----------------- Helpers -----------------

function recipeFromRow(row: PhotoTransformRow | null): PhotoTransformRecipe {
  if (!row) {
    return {
      crop: null,
      rotation: 0,
      exposure: 0,
      contrast: 0,
      gamma: 1,
      white_point: null,
      black_point: null,
    }
  }
  return {
    crop: row.crop,
    rotation: row.rotation,
    exposure: row.exposure,
    contrast: row.contrast,
    gamma: row.gamma,
    white_point: row.white_point,
    black_point: row.black_point,
  }
}

/**
 * Build a centred crop for the requested aspect ratio in normalised
 * coords, given the image's natural pixel dimensions. Returns null when
 * the image hasn't loaded yet (the caller waits for `loaded`).
 */
function centredCropForRatio(
  ratio: PhotoTransformAspectRatio,
): PhotoTransformCrop | null {
  if (!naturalWidth.value || !naturalHeight.value) return null
  const cropAR = aspectRatioToFloat(ratio)
  const imgAR = naturalWidth.value / naturalHeight.value
  // wn / hn = cropAR / imgAR.
  const r = cropAR / imgAR
  let w: number
  let h: number
  if (r >= 1) {
    w = 1
    h = 1 / r
  } else {
    w = r
    h = 1
  }
  return {
    x: (1 - w) / 2,
    y: (1 - h) / 2,
    w,
    h,
  }
}

function aspectRatioToFloat(r: PhotoTransformAspectRatio): number {
  const parts = r.split(':').map(Number)
  return (parts[0] ?? 1) / (parts[1] ?? 1)
}

function applyRatio(ratio: PhotoTransformAspectRatio | 'free') {
  selectedRatio.value = ratio
  if (ratio === 'free') {
    // Keep the existing crop as-is, but switching back to "free" doesn't
    // change anything. (No-op for now; reserved for the cropper UI.)
    return
  }
  // Prefer the AI suggestion's crop for this ratio, fall back to centred.
  const suggested = bundle.value?.suggestion?.crops[ratio]
  recipe.value = {
    ...recipe.value,
    crop: suggested ?? centredCropForRatio(ratio),
  }
}

async function applyAutoLevels() {
  computingAutoLevels.value = true
  error.value = null
  try {
    const result = await computePhotoAutoLevels(props.photoId, recipe.value.crop ?? null)
    recipe.value = {
      ...recipe.value,
      exposure: result.exposure,
      contrast: result.contrast,
      gamma: result.gamma,
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    computingAutoLevels.value = false
  }
}

function applyAiSuggestion() {
  const s = bundle.value?.suggestion
  if (!s) return
  // Copy the whole exposure recipe; let the user pick the ratio
  // explicitly via "Anwenden" on the desired ratio chip.
  recipe.value = {
    ...recipe.value,
    exposure: s.exposure,
    contrast: s.contrast,
    gamma: s.gamma,
    white_point: s.white_point ?? null,
    black_point: s.black_point ?? null,
  }
  // If the user already picked a ratio that the suggestion supports, snap
  // the crop too.
  if (selectedRatio.value !== 'free' && s.crops[selectedRatio.value]) {
    recipe.value.crop = s.crops[selectedRatio.value]!
  }
}

async function materializeAt(ratio: PhotoTransformAspectRatio) {
  saving.value = true
  error.value = null
  try {
    const row = await materializePhotoTransform(props.photoId, ratio)
    bundle.value = { ...(bundle.value as PhotoTransformsBundle), mine: row }
    recipe.value = recipeFromRow(row)
    selectedRatio.value = ratio
    emit('saved', row)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function adoptOther(other: PhotoTransformOther) {
  saving.value = true
  error.value = null
  try {
    const row = await adoptPhotoTransform(props.photoId, other.id)
    bundle.value = { ...(bundle.value as PhotoTransformsBundle), mine: row }
    recipe.value = recipeFromRow(row)
    emit('saved', row)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function save() {
  saving.value = true
  error.value = null
  try {
    const row = await upsertPhotoTransform(props.photoId, {
      crop: recipe.value.crop ?? null,
      rotation: recipe.value.rotation ?? 0,
      exposure: recipe.value.exposure ?? 0,
      contrast: recipe.value.contrast ?? 0,
      gamma: recipe.value.gamma ?? 1,
      white_point: recipe.value.white_point ?? null,
      black_point: recipe.value.black_point ?? null,
    })
    bundle.value = { ...(bundle.value as PhotoTransformsBundle), mine: row }
    emit('saved', row)
    emit('update:visible', false)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function reset() {
  // Reset to the loaded value (mine) if present, otherwise to all-neutral.
  recipe.value = recipeFromRow(bundle.value?.mine ?? null)
  selectedRatio.value = 'free'
}

async function deleteMine() {
  if (!bundle.value?.mine) {
    // Nothing to delete on the server; just reset locally.
    await reset()
    return
  }
  saving.value = true
  error.value = null
  try {
    await deletePhotoTransform(props.photoId)
    bundle.value = { ...(bundle.value as PhotoTransformsBundle), mine: null }
    recipe.value = recipeFromRow(null)
    selectedRatio.value = 'free'
    emit('deleted')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function load() {
  loading.value = true
  error.value = null
  try {
    bundle.value = await getPhotoTransforms(props.photoId)
    recipe.value = recipeFromRow(bundle.value.mine)
    // If we landed on an existing crop, mark its ratio in the picker so
    // the chip selection state matches.
    if (recipe.value.crop && naturalWidth.value && naturalHeight.value) {
      selectedRatio.value = guessRatioFromCrop(recipe.value.crop) ?? 'free'
    } else {
      selectedRatio.value = 'free'
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function guessRatioFromCrop(
  crop: PhotoTransformCrop,
): PhotoTransformAspectRatio | null {
  if (!naturalWidth.value || !naturalHeight.value) return null
  const cropAR =
    (crop.w * naturalWidth.value) / (crop.h * naturalHeight.value)
  let best: PhotoTransformAspectRatio | null = null
  let bestErr = 0.05
  for (const opt of ratioOptions) {
    const target = aspectRatioToFloat(opt.key)
    const relErr = Math.abs(cropAR - target) / target
    if (relErr < bestErr) {
      bestErr = relErr
      best = opt.key
    }
  }
  return best
}

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  naturalWidth.value = img.naturalWidth
  naturalHeight.value = img.naturalHeight
  // Re-guess ratio now that we know natural dimensions.
  if (recipe.value.crop && selectedRatio.value === 'free') {
    selectedRatio.value = guessRatioFromCrop(recipe.value.crop) ?? 'free'
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) load()
  },
)

onMounted(() => {
  if (props.visible) load()
})
</script>

<template>
  <Dialog
    :visible="props.visible"
    @update:visible="(v) => emit('update:visible', v)"
    modal
    header="Foto bearbeiten"
    :style="{ width: '64rem', maxWidth: '95vw' }"
    :pt="{ content: { style: 'padding: 0' } }"
  >
    <!-- SVG defs for gamma / black-white-point filter, referenced by id -->
    <svg width="0" height="0" style="position: absolute; pointer-events: none">
      <defs v-html="svgFilterMarkup"></defs>
    </svg>

    <div class="editor-grid">
      <!-- Interactive cropper. The image inside it carries the live
           colour recipe; the user drags the rectangle / handles to set
           the crop. -->
      <div class="preview-wrap">
        <PhotoCropper
          v-if="naturalWidth > 0 && naturalHeight > 0"
          :src="originalUrl"
          :crop="effectiveCrop"
          :image-aspect="imageAspect"
          :aspect-ratio="cropAspectRatio"
          :img-style="cropperImgStyle"
          @update:crop="(c) => (recipe.crop = c)"
        />
        <!-- Hidden probe image: fires @load so we know the natural
             pixel dimensions before instantiating the cropper. -->
        <img
          v-show="!naturalWidth"
          :src="originalUrl"
          alt=""
          style="max-width: 100%; max-height: 60vh"
          @load="onImageLoad"
        />
      </div>

      <!-- Controls -->
      <div class="controls">
        <Message v-if="error" severity="error" :closable="false">
          {{ error }}
        </Message>

        <section class="control-section">
          <h4>Format</h4>
          <div class="ratio-chips">
            <Button
              v-for="opt in ratioOptions"
              :key="opt.key"
              :label="opt.label"
              size="small"
              :severity="selectedRatio === opt.key ? 'primary' : 'secondary'"
              :outlined="selectedRatio !== opt.key"
              @click="applyRatio(opt.key)"
              :disabled="loading"
            />
            <Button
              label="Frei"
              size="small"
              :severity="selectedRatio === 'free' ? 'primary' : 'secondary'"
              :outlined="selectedRatio !== 'free'"
              @click="applyRatio('free')"
              :disabled="loading"
            />
          </div>
        </section>

        <section
          v-if="bundle?.suggestion"
          class="control-section suggestion-section"
        >
          <h4>KI-Vorschlag</h4>
          <div class="suggestion-row">
            <span class="hint">
              Belichtung {{ bundle.suggestion.exposure.toFixed(1) }} EV,
              Kontrast {{ bundle.suggestion.contrast.toFixed(2) }}
            </span>
            <Button
              label="Belichtung übernehmen"
              size="small"
              outlined
              @click="applyAiSuggestion"
              :disabled="loading"
            />
            <Button
              v-if="hasSuggestionForRatio && selectedRatio !== 'free'"
              :label="`Crop & Belichtung übernehmen (${selectedRatio})`"
              size="small"
              @click="materializeAt(selectedRatio as PhotoTransformAspectRatio)"
              :loading="saving"
            />
          </div>
        </section>

        <section v-if="sortedOthers.length > 0" class="control-section">
          <h4>Übernehmen von anderen</h4>
          <div class="ratio-chips">
            <Button
              v-for="other in sortedOthers"
              :key="other.id"
              :label="other.user.name"
              size="small"
              outlined
              @click="adoptOther(other)"
              :disabled="saving"
            />
          </div>
        </section>

        <section class="control-section">
          <div class="section-head">
            <h4>Bildanpassungen</h4>
            <div class="section-actions">
              <Button
                label="Auto"
                size="small"
                outlined
                icon="pi pi-bolt"
                v-tooltip.top="'Belichtung anhand der aktuellen Crop-Region berechnen'"
                @click="applyAutoLevels"
                :loading="computingAutoLevels"
                :disabled="loading"
              />
              <Button
                :icon="showOriginal ? 'pi pi-eye-slash' : 'pi pi-eye'"
                size="small"
                outlined
                v-tooltip.top="'Vorher/Nachher (halten)'"
                @pointerdown="showOriginal = true"
                @pointerup="showOriginal = false"
                @pointerleave="showOriginal = false"
                @pointercancel="showOriginal = false"
              />
            </div>
          </div>
          <div class="slider-row">
            <label>Belichtung</label>
            <Slider
              v-model="recipe.exposure"
              :min="-2"
              :max="2"
              :step="0.05"
              class="slider"
            />
            <span class="slider-value">{{ (recipe.exposure ?? 0).toFixed(2) }} EV</span>
          </div>
          <div class="slider-row">
            <label>Kontrast</label>
            <Slider
              v-model="recipe.contrast"
              :min="-1"
              :max="1"
              :step="0.05"
              class="slider"
            />
            <span class="slider-value">{{ (recipe.contrast ?? 0).toFixed(2) }}</span>
          </div>
          <div class="slider-row">
            <label>Gamma</label>
            <Slider
              v-model="recipe.gamma"
              :min="0.5"
              :max="2.5"
              :step="0.05"
              class="slider"
            />
            <span class="slider-value">{{ (recipe.gamma ?? 1).toFixed(2) }}</span>
          </div>
          <div class="slider-row">
            <label>Schwarzpunkt</label>
            <Slider
              :modelValue="recipe.black_point ?? 0"
              @update:modelValue="(v: number | number[]) => (recipe.black_point = Array.isArray(v) ? v[0]! : (v === 0 ? null : v))"
              :min="0"
              :max="0.4"
              :step="0.01"
              class="slider"
            />
            <span class="slider-value">{{ (recipe.black_point ?? 0).toFixed(2) }}</span>
          </div>
          <div class="slider-row">
            <label>Weißpunkt</label>
            <Slider
              :modelValue="recipe.white_point ?? 1"
              @update:modelValue="(v: number | number[]) => (recipe.white_point = Array.isArray(v) ? v[0]! : (v === 1 ? null : v))"
              :min="0.6"
              :max="1"
              :step="0.01"
              class="slider"
            />
            <span class="slider-value">{{ (recipe.white_point ?? 1).toFixed(2) }}</span>
          </div>
        </section>

        <section class="control-section">
          <h4>Drehung</h4>
          <div class="ratio-chips">
            <Button
              v-for="r in [0, 90, 180, 270]"
              :key="r"
              :label="`${r}°`"
              size="small"
              :severity="(recipe.rotation ?? 0) === r ? 'primary' : 'secondary'"
              :outlined="(recipe.rotation ?? 0) !== r"
              @click="recipe.rotation = r"
            />
          </div>
        </section>
      </div>
    </div>

    <template #footer>
      <div class="footer-buttons">
        <Button
          label="Zurücksetzen"
          severity="secondary"
          outlined
          @click="reset"
          :disabled="saving || loading"
        />
        <Button
          label="Meinen Schnitt löschen"
          severity="danger"
          outlined
          @click="deleteMine"
          :disabled="saving || loading || !bundle?.mine"
        />
        <div class="spacer" />
        <Button
          label="Abbrechen"
          severity="secondary"
          @click="emit('update:visible', false)"
        />
        <Button
          label="Speichern"
          @click="save"
          :loading="saving"
          :disabled="loading"
        />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.editor-grid {
  display: grid;
  grid-template-columns: 1fr 22rem;
  gap: 1rem;
  padding: 1rem;
}

@media (max-width: 900px) {
  .editor-grid {
    grid-template-columns: 1fr;
  }
}

.preview-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 20rem;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-height: 70vh;
  overflow-y: auto;
}

.control-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.control-section h4 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.section-actions {
  display: flex;
  gap: 0.25rem;
}

.ratio-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.suggestion-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.suggestion-row .hint {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  flex: 1 1 100%;
}

.slider-row {
  display: grid;
  grid-template-columns: 6rem 1fr 4rem;
  gap: 0.5rem;
  align-items: center;
}

.slider-row label {
  font-size: 0.875rem;
}

.slider-row .slider {
  width: 100%;
}

.slider-row .slider-value {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.footer-buttons {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
}

.footer-buttons .spacer {
  flex: 1;
}
</style>
