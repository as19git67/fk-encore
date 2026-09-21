<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Drawer from 'primevue/drawer'
import Message from 'primevue/message'

/**
 * The basket in the navbar, and the drawer behind it (issue #1272, stage 5).
 *
 * Documents and finance each had their own copy of this: the same cart
 * button with the same badge, the same drawer with the same header, empty
 * state, row list and footer — and the same message plumbing for "done" and
 * "that failed". What actually differs is what a row looks like and what the
 * footer can do with the pile, so that is what stays outside, in the slots.
 *
 *   <BasketIndicator :count="store.count" singular="Dokument" plural="Dokumente">
 *     <template #rows>  … one <li class="basket-row"> per item …  </template>
 *     <template #footer> … the module's batch actions …          </template>
 *   </BasketIndicator>
 *
 * The badge gives a short pulse whenever the pile grows, so adding something
 * from far down a list is visible without moving the eye to the corner.
 */

const props = withDefaults(
  defineProps<{
    count: number
    /** What one item is called, for the tooltip and the header. */
    singular: string
    plural: string
    title?: string
    /** First line of the empty state. */
    emptyText?: string
    /** The quiet line under it that says how things get in here. */
    emptyHint?: string
    /** A success line shown above the footer actions; `null` hides it. */
    info?: string | null
    /** A failure line, same place. */
    error?: string | null
  }>(),
  {
    title: 'Basket',
    emptyText: undefined,
    emptyHint: undefined,
    info: null,
    error: null,
  },
)

const emit = defineEmits<{
  (e: 'update:info', value: null): void
  (e: 'update:error', value: null): void
}>()

const visible = ref(false)

const noun = computed(() => (props.count === 1 ? props.singular : props.plural))
const countLabel = computed(() => `${props.count} ${noun.value}`)
const tooltip = computed(() =>
  props.count === 0 ? `${props.title} (leer)` : `${props.title} · ${countLabel.value}`,
)

/** A short pulse when the pile grows — never when it shrinks. */
const pulsing = ref(false)
let pulseTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => props.count,
  (next, previous) => {
    if (next <= previous) return
    pulsing.value = true
    if (pulseTimer) clearTimeout(pulseTimer)
    pulseTimer = setTimeout(() => {
      pulsing.value = false
    }, 450)
  },
)

defineExpose({
  open: () => {
    visible.value = true
  },
  close: () => {
    visible.value = false
  },
})
</script>

<template>
  <div class="basket-indicator">
    <Button
      v-tooltip.bottom="tooltip"
      icon="pi pi-shopping-cart"
      severity="secondary"
      text
      rounded
      :badge="count > 0 ? String(count) : undefined"
      badge-severity="info"
      :aria-label="`${title} öffnen`"
      class="basket-button"
      :class="{ 'basket-button--pulse': pulsing }"
      data-testid="basket-button"
      @click="visible = true"
    />

    <Drawer v-model:visible="visible" position="right" :header="title" class="basket-drawer">
      <template #header>
        <div class="drawer-header">
          <span class="drawer-title">{{ title }}</span>
          <span v-if="count > 0" class="drawer-count">{{ countLabel }}</span>
          <!-- What the module wants to add to the header, e.g. a sum. -->
          <slot name="subtitle" />
        </div>
      </template>

      <div v-if="count === 0" class="basket-empty">
        <i class="pi pi-shopping-cart basket-empty-icon" />
        <p>{{ emptyText ?? `Noch keine ${plural} im ${title}.` }}</p>
        <p v-if="emptyHint" class="hint">{{ emptyHint }}</p>
      </div>

      <template v-else>
        <!-- Anything the module shows above the pile: an analysis, a hint. -->
        <slot name="before-rows" />
        <ul class="basket-list">
          <slot name="rows" />
        </ul>
      </template>

      <template #footer>
        <div class="drawer-footer">
          <Message
            v-if="info"
            severity="success"
            :closable="true"
            class="action-message"
            @close="emit('update:info', null)"
            >{{ info }}</Message
          >
          <Message
            v-if="error"
            severity="error"
            :closable="true"
            class="action-message"
            @close="emit('update:error', null)"
            >{{ error }}</Message
          >
          <slot name="footer" />
        </div>
      </template>
    </Drawer>
  </div>
</template>

<style scoped>
.basket-indicator {
  display: inline-flex;
}

.basket-button--pulse {
  animation: basket-pulse 0.45s ease-out;
}
@keyframes basket-pulse {
  0% { transform: scale(1); }
  40% { transform: scale(1.18); }
  100% { transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .basket-button--pulse {
    animation: none;
  }
}

.drawer-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
  min-width: 0;
}
.drawer-title {
  font-weight: 600;
}
.drawer-count {
  color: var(--p-text-muted-color);
  font-size: var(--text-base);
}

.basket-empty {
  text-align: center;
  color: var(--p-text-muted-color);
  padding: 2rem 1rem;
}
.basket-empty-icon {
  font-size: var(--text-5xl);
  display: block;
  margin-bottom: 0.75rem;
}
.basket-empty .hint {
  font-size: var(--text-base);
  margin-top: 0.25rem;
}

.basket-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}

.drawer-footer {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.action-message {
  margin: 0;
}
</style>

<style>
/* The rows come from the module through a slot, so their look cannot be
   scoped to this component — it is the same look in both baskets, and it
   belongs with the shell that arranges them. */
.basket-drawer .basket-row {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}
.basket-drawer .basket-row:last-child {
  border-bottom: none;
}
.basket-drawer .basket-row-body {
  appearance: none;
  background: none;
  border: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  flex: 1;
  min-width: 0;
  padding: 0.25rem;
  border-radius: 0.25rem;
}
.basket-drawer .basket-row-body:hover,
.basket-drawer .basket-row-body:focus-visible {
  background: var(--p-content-hover-background);
}
.basket-drawer .basket-row-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.basket-drawer .basket-row-meta {
  margin-top: 0.1rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
}
.basket-drawer .basket-row-meta span {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.basket-drawer .basket-row-remove {
  background: none;
  border: none;
  padding: 0.25rem;
  cursor: pointer;
  color: var(--p-text-muted-color);
  border-radius: 0.25rem;
  flex-shrink: 0;
}
.basket-drawer .basket-row-remove:hover {
  color: var(--p-text-color);
  background: var(--p-content-hover-background);
}
.basket-drawer .action-row {
  display: flex;
  gap: 0.5rem;
}
.basket-drawer .action-row .p-button {
  flex: 1;
}
</style>
