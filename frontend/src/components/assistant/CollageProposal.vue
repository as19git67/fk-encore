<script setup lang="ts">
/**
 * A collage the assistant proposed, on its card: the photos drawn in the
 * chosen layout with the caption where it will sit. Until "Ausführen" the
 * layout, the caption, its place (a 3×3 picker: the edges, the corners, the
 * middle) and its size can be changed; the server renders exactly that
 * (`photo/collage.ts` uses the same layout table). Afterwards the card shows
 * the rendered photo and offers it for download.
 */
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import SelectButton from 'primevue/selectbutton'
import { downloadResult, type CollagePreview, type CollageTextPosition, type CollageTextSize } from '../../api/assistant'
import { getPhotoUrl } from '../../api/photos'
import { collageLayouts, collageObjectPosition } from '../../utils/collageLayouts'
import {
  COLLAGE_CAPTION_GRID,
  COLLAGE_CAPTION_LABELS,
  COLLAGE_TEXT_FONTS,
  captionPlacement,
  collageFontPreset,
} from '../../utils/collageText'

export interface CollageForm {
  layout: string
  text: string
  text_position: CollageTextPosition
  text_size: CollageTextSize
}

const props = defineProps<{
  collage: CollagePreview
  /** Editable while the proposal waits. */
  editable: boolean
  disabled?: boolean
  idPrefix: string
}>()
const form = defineModel<CollageForm>({ required: true })

const PREVIEW_WIDTH = 600
const MAX_HEIGHT_REM = 24

const layouts = computed(() => collageLayouts(props.collage.photos.length))
const layout = computed(() => layouts.value.find((l) => l.id === form.value.layout) ?? layouts.value[0])
const layoutOptions = computed(() => layouts.value.map((l) => ({ label: l.name, value: l.id })))
const sizeOptions = COLLAGE_TEXT_FONTS.map((f) => ({ label: f.label, value: f.key }))

const result = computed(() => props.collage.result)

/** As wide as the card allows, but never taller than MAX_HEIGHT_REM. */
function stageStyle(aspect: number) {
  return { aspectRatio: String(aspect), width: `min(100%, ${MAX_HEIGHT_REM * aspect}rem)` }
}

function cellStyle(cell: { x: number; y: number; w: number; h: number }) {
  return {
    left: `${cell.x * 100}%`,
    top: `${cell.y * 100}%`,
    width: `${cell.w * 100}%`,
    height: `${cell.h * 100}%`,
  }
}

const caption = computed(() => {
  const text = form.value.text.trim()
  if (!text) return null
  const { align, vertical } = captionPlacement(form.value.text_position)
  return {
    text,
    style: {
      justifyContent: vertical === 'top' ? 'flex-start' : vertical === 'bottom' ? 'flex-end' : 'center',
      alignItems: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center',
      textAlign: align,
      color: props.collage.text_color,
      fontSize: `${collageFontPreset(form.value.text_size).heightFraction * 100}cqh`,
    },
  }
})

const resultAspect = ref<number | null>(null)
function onResultLoad(ev: Event) {
  const img = ev.target as HTMLImageElement
  if (img.naturalWidth && img.naturalHeight) resultAspect.value = img.naturalWidth / img.naturalHeight
}

const downloading = ref(false)
const downloadError = ref<string | null>(null)
async function download() {
  if (!result.value || downloading.value) return
  downloading.value = true
  downloadError.value = null
  try {
    await downloadResult(`/photos/file/${encodeURI(result.value.filename)}`, 'collage.jpg')
  } catch (e) {
    downloadError.value = e instanceof Error ? e.message : 'Der Download ist fehlgeschlagen.'
  } finally {
    downloading.value = false
  }
}

const id = (name: string) => `${props.idPrefix}-${name}`
</script>

<template>
  <div class="collage">
    <img
      v-if="result"
      class="collage-result"
      :src="getPhotoUrl(result.filename, 1200)"
      alt="Die fertige Collage"
      :style="stageStyle(resultAspect ?? layout?.aspect ?? 1)"
      @load="onResultLoad"
    />
    <div
      v-else-if="layout"
      class="collage-stage"
      :style="stageStyle(layout.aspect)"
      role="img"
      :aria-label="`Vorschau: ${layout.name}${caption ? `, Text „${caption.text}“ ${COLLAGE_CAPTION_LABELS[form.text_position].toLowerCase()}` : ''}`"
    >
      <div v-for="(cell, i) in layout.cells" :key="i" class="collage-cell" :style="cellStyle(cell)">
        <img
          v-if="collage.photos[i]"
          :src="getPhotoUrl(collage.photos[i]!.filename, PREVIEW_WIDTH)"
          alt=""
          loading="lazy"
          :style="{ objectPosition: collageObjectPosition(collage.photos[i]!.auto_crop) }"
        />
      </div>
      <div v-if="caption" class="collage-caption" :style="caption.style">
        <span>{{ caption.text }}</span>
      </div>
    </div>

    <div v-if="result" class="collage-actions">
      <Button
        label="Herunterladen"
        icon="pi pi-download"
        severity="secondary"
        outlined
        class="collage-action"
        :loading="downloading"
        @click="download"
      />
    </div>
    <p v-if="downloadError" class="collage-error" role="alert">
      <i class="pi pi-exclamation-circle" aria-hidden="true" />
      {{ downloadError }}
    </p>

    <div v-if="editable && !result" class="collage-form">
      <div class="collage-field">
        <span :id="id('layout')" class="collage-label">Layout</span>
        <SelectButton
          v-model="form.layout"
          :options="layoutOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          :disabled="disabled"
          :aria-labelledby="id('layout')"
        />
      </div>
      <div class="collage-field">
        <label :for="id('text')" class="collage-label">Text (optional)</label>
        <InputText :id="id('text')" v-model="form.text" :maxlength="200" :disabled="disabled" />
      </div>
      <div class="collage-row">
        <div class="collage-field">
          <span :id="id('position')" class="collage-label">Position</span>
          <div class="collage-positions" role="group" :aria-labelledby="id('position')">
            <Button
              v-for="p in COLLAGE_CAPTION_GRID"
              :key="p"
              :icon="form.text_position === p ? 'pi pi-circle-fill' : 'pi pi-circle'"
              :severity="form.text_position === p ? undefined : 'secondary'"
              :outlined="form.text_position !== p"
              size="small"
              :aria-label="COLLAGE_CAPTION_LABELS[p]"
              :aria-pressed="form.text_position === p"
              v-tooltip.top="COLLAGE_CAPTION_LABELS[p]"
              :disabled="disabled || !form.text.trim()"
              @click="form.text_position = p"
            />
          </div>
        </div>
        <div class="collage-field">
          <span :id="id('size')" class="collage-label">Schriftgröße</span>
          <SelectButton
            v-model="form.text_size"
            :options="sizeOptions"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            :disabled="disabled || !form.text.trim()"
            :aria-labelledby="id('size')"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.collage {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.collage-stage {
  position: relative;
  background: var(--p-content-hover-background);
  border-radius: 4px;
  overflow: hidden;
  /* Caption sizes are a fraction of the stage height (cqh), like the render. */
  container-type: size;
}

.collage-result {
  display: block;
  border-radius: 4px;
  object-fit: contain;
}

.collage-cell {
  position: absolute;
  padding: 1px;
}

.collage-cell img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.collage-caption {
  position: absolute;
  inset: 5%;
  display: flex;
  flex-direction: column;
  pointer-events: none;
}

.collage-caption span {
  max-width: 100%;
  font-weight: 700;
  line-height: 1.25;
  white-space: pre-wrap;
  overflow-wrap: normal;
  /* The render's dark outline, so the preview reads the same over any photo. */
  -webkit-text-stroke: 0.06em rgba(0, 0, 0, 0.7);
  paint-order: stroke fill;
}

.collage-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.collage-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.collage-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.collage-label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}

/* Three layout names do not fit side by side on a phone. */
.collage-field :deep(.p-selectbutton) {
  flex-wrap: wrap;
}

.collage-positions {
  display: grid;
  grid-template-columns: repeat(3, auto);
  gap: var(--space-1);
  justify-content: start;
}

.collage-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* A thumb-sized target (44px). */
.collage-action {
  min-height: 44px;
}

.collage-error {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-red-600);
}
</style>
