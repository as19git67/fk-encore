<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useSlots } from 'vue'
import Button from 'primevue/button'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import InputText from 'primevue/inputtext'
import Menu from 'primevue/menu'
import SelectButton from 'primevue/selectbutton'
import FilterChips from '../FilterChips.vue'
import { formatResultCount, isSearchHotkey } from './listToolbar'
import type { ListToolbarModel } from './listToolbar'

/**
 * The one toolbar every list view puts in `PageLayout`'s `#toolbar` slot
 * (issue #1272, stage 3; concept §3).
 *
 * Fixed order, everywhere the same:
 *
 *   [ search ] [ filter (n) ] [ sort ] [ view ] [ select ]
 *   [chip] [chip] [alle entfernen]                 „123 von 4.567"
 *
 * The first row carries what the user operates, the second what the list
 * currently *is*. Both rows exist at every width, so nothing jumps between
 * layouts; below `sm` the buttons drop their labels and become icons.
 *
 * A view with a search bar of its own (the gallery's natural-language
 * search) fills the `search` slot instead of handing over `model.search`.
 */

const props = defineProps<{
  model: ListToolbarModel
}>()

const slots = useSlots()

/** PrimeVue's own types do not surface `$el`, so it is named here. */
const searchInput = ref<{ $el?: unknown } | null>(null)
const searchArea = ref<HTMLElement | null>(null)
const sortMenu = ref<InstanceType<typeof Menu> | null>(null)

const chips = computed(() => props.model.filter?.chips.value ?? [])
const activeFilters = computed(() => props.model.filter?.activeCount.value ?? 0)

/** How many criteria are active, as a badge that survives the narrow layout
 *  where the button keeps only its icon. */
const filterBadge = computed(() =>
  activeFilters.value > 0 ? String(activeFilters.value) : undefined,
)
const filterTooltip = computed(() =>
  activeFilters.value > 0 ? `${activeFilters.value} Filter aktiv` : 'Filter',
)

/**
 * A filter panel that stays open makes the button a toggle, and a toggle has
 * to look switched on — otherwise the only thing that changed on click is
 * somewhere else on the page. Filled instead of outlined, the same way the
 * view switcher marks its active option.
 */
const filterExpanded = computed(() => props.model.filter?.expanded?.value ?? false)

const countLabel = computed(() =>
  formatResultCount(props.model.result.loaded.value, props.model.result.total.value),
)

const sortItems = computed(() => {
  const sort = props.model.sort
  if (!sort) return []
  return sort.fields.map((field) => {
    const active = sort.applied.value.field === field.value
    const ascending = sort.applied.value.direction === 'asc'
    return {
      label: field.label,
      // The active field shows its direction and flips on the next click.
      icon: active ? (ascending ? 'pi pi-sort-amount-up' : 'pi pi-sort-amount-down') : 'pi pi-fw',
      class: active ? 'list-toolbar__sort-item--active' : undefined,
      command: () => sort.select(field.value),
    }
  })
})

const sortLabel = computed(() => props.model.sort?.fieldLabel.value ?? 'Sortierung')

function onSearchInput(value: string | undefined) {
  const search = props.model.search
  if (!search) return
  search.value.value = value ?? ''
}

/** The field is a component, so the element to focus sits behind its `$el`. */
function searchElement(): HTMLInputElement | null {
  const el = searchInput.value?.$el
  return el instanceof HTMLInputElement ? el : null
}

function clearSearch() {
  const search = props.model.search
  if (!search) return
  search.value.value = ''
  searchElement()?.focus()
}

function toggleSortMenu(event: Event) {
  sortMenu.value?.toggle(event)
}

function onViewChange(value: unknown) {
  const view = props.model.view
  // SelectButton hands `null` back when the active option is clicked again;
  // a list always has exactly one view, so that click means "stay".
  if (!view || typeof value !== 'string') return
  view.value.value = value
}

/**
 * The keyboard contract, identical on every list: `/` jumps to the search,
 * `Esc` inside it clears, `Esc` outside leaves select mode. While any
 * dialog is open its own Esc handling wins.
 */
function focusableSearch(): HTMLInputElement | null {
  // A view that fills the `search` slot (the gallery's natural-language bar)
  // brings its own input; the hotkey must still land in it.
  return searchElement() ?? searchArea.value?.querySelector('input') ?? null
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (isSearchHotkey(event)) {
    const input = focusableSearch()
    if (!input) return
    event.preventDefault()
    input.focus()
    input.select()
    return
  }
  if (event.key !== 'Escape') return
  if (typeof document !== 'undefined' && document.querySelector('[role="dialog"]')) return
  const selection = props.model.selection
  if (selection?.active.value) {
    event.preventDefault()
    selection.toggle()
  }
}

onMounted(() => document.addEventListener('keydown', onDocumentKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onDocumentKeydown))
</script>

<template>
  <div class="list-toolbar" data-testid="list-toolbar">
    <div class="list-toolbar__main">
      <div
        v-if="slots.search || model.search"
        ref="searchArea"
        class="list-toolbar__search"
        :class="{ 'list-toolbar__search--custom': !!slots.search }"
      >
        <slot name="search">
          <!-- PrimeVue's own field, so the search sits at the same height, in
               the same rounding and with the same focus ring as the buttons
               beside it — a hand-styled input drifted from the theme. -->
          <IconField class="list-toolbar__field">
            <InputIcon class="pi pi-search" />
            <InputText
              ref="searchInput"
              size="small"
              :model-value="model.search!.value.value"
              :placeholder="model.search!.placeholder"
              :aria-label="model.search!.placeholder"
              data-testid="list-search"
              @update:model-value="onSearchInput"
              @keydown.escape.stop.prevent="clearSearch"
            />
            <InputIcon
              v-if="model.search!.value.value"
              class="pi pi-times list-toolbar__search-clear"
              role="button"
              tabindex="0"
              aria-label="Suche leeren"
              @click="clearSearch"
              @keydown.enter.prevent="clearSearch"
            />
          </IconField>
        </slot>
      </div>

      <div class="list-toolbar__controls">
        <Button
          v-if="model.filter?.open"
          icon="pi pi-filter"
          label="Filter"
          :badge="filterBadge"
          badge-severity="info"
          size="small"
          :outlined="!filterExpanded"
          :severity="activeFilters > 0 ? 'primary' : 'secondary'"
          class="list-toolbar__button"
          data-testid="list-filter"
          :aria-label="filterTooltip"
          :aria-expanded="model.filter.expanded ? filterExpanded : undefined"
          v-tooltip.bottom="filterTooltip"
          @click="model.filter!.open!($event)"
        />

        <template v-if="model.sort">
          <Button
            icon="pi pi-sort-alt"
            :label="sortLabel"
            size="small"
            outlined
            severity="secondary"
            class="list-toolbar__button"
            aria-haspopup="true"
            data-testid="list-sort"
            v-tooltip.bottom="'Sortierung'"
            @click="toggleSortMenu"
          />
          <Menu ref="sortMenu" :model="sortItems" :popup="true" />
        </template>

        <SelectButton
          v-if="model.view"
          :model-value="model.view.value.value"
          :options="model.view.options"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          size="small"
          class="list-toolbar__view"
          data-testid="list-view"
          @update:model-value="onViewChange"
        >
          <template #option="{ option }">
            <i v-if="option.icon" :class="option.icon" aria-hidden="true" />
            <span class="list-toolbar__view-label">{{ option.label }}</span>
          </template>
        </SelectButton>

        <Button
          v-if="model.selection"
          :icon="model.selection.active.value ? 'pi pi-times' : 'pi pi-check-square'"
          :label="model.selection.active.value ? 'Auswahl beenden' : 'Auswählen'"
          size="small"
          :outlined="!model.selection.active.value"
          severity="secondary"
          class="list-toolbar__button"
          data-testid="list-select"
          @click="model.selection.toggle()"
        />

        <slot name="actions" />
      </div>
    </div>

    <div class="list-toolbar__meta">
      <FilterChips v-if="chips.length" :chips="chips" class="list-toolbar__chips" />
      <Button
        v-if="chips.length > 1 && model.filter"
        label="Alle entfernen"
        icon="pi pi-times"
        size="small"
        text
        severity="secondary"
        class="list-toolbar__clear-all"
        @click="model.filter.clearAll()"
      />
      <span class="list-toolbar__count" data-testid="list-count">
        <i v-if="model.result.loading.value" class="pi pi-spin pi-spinner" aria-label="Lädt" />
        <template v-else>{{ countLabel }}</template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.list-toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.list-toolbar__main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}

.list-toolbar__search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 14rem;
  min-width: 0;
  max-width: 32rem;
}
/* A slotted bar brings its own layout (the natural-language search carries a
   button and its parsed chips), so it is not squeezed into the plain input's
   width. */
.list-toolbar__search--custom {
  flex-basis: 24rem;
  max-width: none;
}

.list-toolbar__field {
  width: 100%;
  min-width: 0;
}
.list-toolbar__field :deep(input) {
  width: 100%;
}

/* The clear icon is an icon slot, so it has to be told it is a control. */
.list-toolbar__search-clear {
  pointer-events: auto;
  cursor: pointer;
}
.list-toolbar__search-clear:hover {
  color: var(--p-text-color);
}

/* The controls take the row that is left beside the search, and below `sm`
   the whole next row. Their width comes from the layout, never from what
   they contain: a content-sized row plus a toolbar that decides its contents
   from the width it gets is a loop, and the page flickers. */
.list-toolbar__controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  flex: 1 1 18rem;
  min-width: 0;
}

.list-toolbar__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  min-width: 0;
}

.list-toolbar__chips {
  min-width: 0;
}

.list-toolbar__count {
  margin-left: auto;
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
  white-space: nowrap;
}

.list-toolbar__view-label {
  margin-left: 0.35rem;
}

/* A spinning glyph's bounding box is wider than the glyph itself (a rotated
   square measures √2 across), and this one sits flush against the right
   edge — without the slack it pokes past a 360px viewport. */
.list-toolbar__count .pi-spin {
  margin-inline: 0.25rem;
}

/* Below sm the buttons keep their icons and drop the words, so the whole
   row still fits one line at 360px. */
@media (max-width: 639px) {
  .list-toolbar__search {
    flex-basis: 100%;
    max-width: none;
  }
  .list-toolbar__button :deep(.p-button-label),
  .list-toolbar__view-label {
    display: none;
  }
  .list-toolbar__clear-all :deep(.p-button-label) {
    display: none;
  }
}
</style>
