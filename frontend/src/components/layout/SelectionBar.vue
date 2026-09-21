<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import ResponsiveToolbar, { type ToolbarItem } from '../ResponsiveToolbar.vue'
import type { UseListSelectionReturn } from '../../composables/useListSelection'
import { formatCount } from './listToolbar'

/**
 * The one bar every list shows while rows are picked (issue #1272, stage 5).
 *
 * Fixed order, everywhere the same:
 *
 *   [☑ alle] [n ausgewählt] [Umkehren] [Aufheben]  …  [Aktionen] [beenden]
 *
 * The photo grids used to float a pill over the grid, documents and finance
 * put different buttons in the page's selection slot, and each spelled the
 * count its own way. One bar, one wording, one place: `PageLayout`'s
 * `selection` slot, which lifts it into the app's sticky stack — except on a
 * phone, where it sits at the bottom, within thumb's reach of the rows being
 * tapped.
 *
 * The actions are the view's own (`ToolbarItem[]`, the same shape the page
 * header uses), so they overflow into a menu exactly like the page's actions
 * do instead of pushing the bar off the screen.
 */

const props = withDefaults(
  defineProps<{
    /** The list's selection, from `useListSelection`. */
    selection: UseListSelectionReturn
    /** What the view can do with the picked rows. */
    actions?: ToolbarItem[]
    /** What one row is called, for the count: "3 Fotos ausgewählt". */
    noun?: string
    /** One line the view wants to add, e.g. a hint while a range resolves. */
    hint?: string
    /** Hide the "end selection" button for a list that is always selectable. */
    dismissible?: boolean
  }>(),
  { actions: () => [], noun: undefined, hint: undefined, dismissible: true },
)

const count = computed(() => props.selection.selectedCount.value)

/**
 * "Nichts ausgewählt" rather than "0 ausgewählt": the bar appears the moment
 * the mode starts, and zero is a state to explain, not a number to report.
 */
const countLabel = computed(() => {
  if (count.value === 0) return props.noun ? `Keine ${props.noun} ausgewählt` : 'Nichts ausgewählt'
  const what = props.noun ? ` ${props.noun}` : ''
  return `${formatCount(count.value)}${what} ausgewählt`
})

const selectAllTooltip = computed(() =>
  props.selection.allSelected.value ? 'Auswahl aufheben' : 'Alle auswählen',
)

function onSelectAllChange(value: unknown) {
  if (value === true) void props.selection.selectAll()
  else props.selection.clear()
}
</script>

<template>
  <div class="selection-bar" data-testid="selection-bar">
    <Checkbox
      :model-value="selection.selectAllState.value"
      :binary="true"
      :indeterminate="selection.selectAllState.value === null"
      :aria-label="selectAllTooltip"
      v-tooltip.bottom="selectAllTooltip"
      data-testid="selection-all"
      @update:model-value="onSelectAllChange"
    />

    <span class="selection-bar__count" data-testid="selection-count">
      <i v-if="selection.rangeBusy.value || selection.selectAllBusy.value" class="pi pi-spin pi-spinner" aria-hidden="true" />
      {{ countLabel }}
    </span>

    <span v-if="hint" class="selection-bar__hint">{{ hint }}</span>

    <!-- What the view wants to say about the picked rows: a sum, a warning. -->
    <slot name="info" />

    <Button
      label="Umkehren"
      icon="pi pi-replay"
      size="small"
      text
      severity="secondary"
      class="selection-bar__button"
      v-tooltip.bottom="'Auswahl umkehren'"
      data-testid="selection-invert"
      @click="selection.invert()"
    />
    <Button
      label="Aufheben"
      icon="pi pi-times-circle"
      size="small"
      text
      severity="secondary"
      class="selection-bar__button"
      :disabled="count === 0"
      v-tooltip.bottom="'Nichts auswählen'"
      data-testid="selection-clear"
      @click="selection.clear()"
    />

    <div class="selection-bar__actions">
      <ResponsiveToolbar v-if="actions.length" :items="actions" />
      <!-- The view's own primary action, e.g. "In den Basket". -->
      <slot name="primary" />
      <Button
        v-if="dismissible"
        icon="pi pi-times"
        size="small"
        text
        severity="secondary"
        aria-label="Auswahl beenden"
        v-tooltip.bottom="'Auswahl beenden'"
        data-testid="selection-exit"
        @click="selection.exit()"
      />
    </div>
  </div>
</template>

<style scoped>
.selection-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  min-width: 0;
}

.selection-bar__count {
  font-weight: 600;
  white-space: nowrap;
}

.selection-bar__hint {
  color: var(--p-text-muted-color);
  font-size: 0.8125rem;
  min-width: 0;
}

/* A spinning glyph's bounding box is wider than the glyph (a rotated square
   measures √2 across), so it gets its own slack instead of pushing the row. */
.selection-bar__count .pi-spin {
  margin-inline: 0.25rem;
}

.selection-bar__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 1 1 12rem;
  min-width: 0;
}

/* On a phone the bar belongs where the thumb is: at the bottom, over the
   list, rather than at the top of a stack the user has scrolled away from.
   It stays in the stack's DOM — only its box moves. */
@media (max-width: 767px) {
  .selection-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: var(--z-selection-bar);
    padding: var(--space-2) var(--page-gutter);
    padding-bottom: calc(var(--space-2) + env(safe-area-inset-bottom));
    background: var(--p-content-background);
    border-top: 1px solid var(--p-content-border-color);
    box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.15);
  }
  /* Below sm the buttons keep their icons and drop the words, so the row
     still fits one line at 360px — the same trade the toolbar makes. */
  .selection-bar__button :deep(.p-button-label) {
    display: none;
  }
}
</style>
