<script setup lang="ts">
/**
 * Narrowing and weighting of a photo book: the same fields when a book is
 * made (`PhotoBookCreateDialog`) and when its selection is changed later
 * (`PhotoBookNarrowingDialog`).
 */
import Checkbox from 'primevue/checkbox'
import InputNumber from 'primevue/inputnumber'
import SelectButton from 'primevue/selectbutton'
import { PHOTO_BOOK_SUBJECTS } from '../../api/photoBooks'
import type { NarrowingDraft } from '../../utils/photoBookNarrowing'

const draft = defineModel<NarrowingDraft>({ required: true })
/** Keeps the input ids apart when two forms are on the page. */
const props = defineProps<{ idPrefix: string }>()
const id = (name: string) => `${props.idPrefix}-${name}`

const WEIGHT_OPTIONS = [
  { label: 'Weniger', value: -1 },
  { label: 'Normal', value: 0 },
  { label: 'Mehr', value: 1 },
]
</script>

<template>
  <fieldset class="pbn-group">
    <legend>Eingrenzen (optional)</legend>
    <div class="pbn-row">
      <Checkbox v-model="draft.useQuality" binary :input-id="id('quality')" />
      <label :for="id('quality')">Qualität mindestens</label>
      <InputNumber v-model="draft.qualityMin" :min="0" :max="100" suffix=" %" :disabled="!draft.useQuality" aria-label="Mindestqualität in Prozent" class="pbn-number" />
    </div>
    <div class="pbn-row">
      <Checkbox v-model="draft.useAesthetic" binary :input-id="id('aesthetic')" />
      <label :for="id('aesthetic')">Ästhetik mindestens</label>
      <InputNumber v-model="draft.aestheticMin" :min="0" :max="100" suffix=" %" :disabled="!draft.useAesthetic" aria-label="Mindestwert Ästhetik in Prozent" class="pbn-number" />
    </div>
    <div class="pbn-row">
      <Checkbox v-model="draft.withoutFaces" binary :input-id="id('faces')" />
      <label :for="id('faces')">Ohne erkennbare Gesichter</label>
    </div>
    <p class="pbn-hint">Kleine oder unscharfe Gesichter im Hintergrund zählen nicht als erkennbar.</p>
    <div class="pbn-row">
      <Checkbox v-model="draft.useMax" binary :input-id="id('max')" />
      <label :for="id('max')">Höchstens</label>
      <InputNumber v-model="draft.maxPhotos" :min="1" :max="600" suffix=" Fotos" :disabled="!draft.useMax" aria-label="Höchstzahl der Fotos" class="pbn-number" />
    </div>
    <p class="pbn-hint">Mit Mindestwerten fallen Fotos ohne Bewertung heraus. Bei einer Höchstzahl bleiben die am besten bewerteten.</p>
    <div class="pbn-row">
      <Checkbox v-model="draft.seriesPicks" binary :input-id="id('series')" />
      <label :for="id('series')">Ähnliche Fotos nur einmal: von Serien und Fotos derselben Szene bleibt das beste</label>
    </div>
  </fieldset>

  <fieldset class="pbn-group pbn-weights">
    <legend>Gewichten (optional)</legend>
    <p class="pbn-hint">Mehr oder weniger von einem Motiv: das ändert, welche Fotos bei einer Höchstzahl bleiben und welche groß stehen.</p>
    <div v-for="s in PHOTO_BOOK_SUBJECTS" :key="s.id" class="pbn-weight">
      <span :id="id(`w-${s.id}`)" class="pbn-weight-label">{{ s.label }}</span>
      <SelectButton
        v-model="draft.weights[s.id]"
        :options="WEIGHT_OPTIONS"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        size="small"
        :aria-labelledby="id(`w-${s.id}`)"
      />
    </div>
  </fieldset>
</template>

<style scoped>
.pbn-group {
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  padding: var(--space-3);
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pbn-weights {
  margin-top: var(--space-3);
}
.pbn-weight {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.pbn-weight-label {
  min-width: 8rem;
}
.pbn-group legend {
  padding: 0 var(--space-1);
  color: var(--p-text-muted-color);
}
.pbn-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.pbn-number :deep(input) {
  width: 7rem;
}
.pbn-hint {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
</style>
