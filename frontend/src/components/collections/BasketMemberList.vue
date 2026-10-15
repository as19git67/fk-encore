<script setup lang="ts">
/**
 * The pile in every basket drawer (#1548): everything in the shared basket,
 * grouped by type, each group under the same header. Every module shows the
 * same list; a module may draw its own type's rows in more detail through the
 * slot `rows-<type>` (documents show their "Neu" mark, bookings their amount)
 * and put that group first.
 *
 * Renders <li> elements only, for the drawer's <ul>.
 */
import { computed } from 'vue'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import Button from 'primevue/button'
import {
  ENTITY_LABELS,
  type CollectionEntityType,
  type CollectionMember,
} from '../../api/collections'
import { useBasketStore } from '../../stores/basket'
import { parseLocalDate } from '../../utils/dateFormat'
import { memberRoute } from '../../utils/collectionRoute'

const props = defineProps<{
  /** The module's own type, shown on top. */
  first?: CollectionEntityType
}>()
const emit = defineEmits<{ (e: 'open'): void }>()

const basket = useBasketStore()
const router = useRouter()

const order = computed(() => {
  const all = Object.keys(ENTITY_LABELS) as CollectionEntityType[]
  return props.first ? [props.first, ...all.filter((t) => t !== props.first)] : all
})

const groups = computed(() =>
  order.value
    .map((type) => ({
      type,
      label: ENTITY_LABELS[type],
      members: basket.members.filter((m) => m.entity_type === type),
    }))
    .filter((group) => group.members.length > 0),
)

function target(member: CollectionMember): RouteLocationRaw | null {
  return memberRoute(member.entity_type, member.entity_id)
}

function open(member: CollectionMember) {
  const to = target(member)
  if (!to) return
  emit('open')
  void router.push(to)
}

/** A date-only value stays on its day; a timestamp shows its local day. */
function formatDate(value: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseLocalDate(value) : new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('de-DE')
}

function formatAmount(member: CollectionMember): string | null {
  if (member.amount == null) return null
  const value = Number(member.amount)
  if (!Number.isFinite(value)) return member.amount
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: member.currency ?? 'EUR' }).format(value)
}
</script>

<template>
  <template v-for="group in groups" :key="group.type">
    <li class="basket-group" aria-hidden="true" :data-testid="`basket-group-${group.type}`">
      <i :class="group.label.icon" />
      {{ group.members.length === 1 ? group.label.singular : group.label.plural }}
      ({{ group.members.length }})
    </li>
    <slot :name="`rows-${group.type}`" :members="group.members">
      <li
        v-for="member in group.members"
        :key="`${member.entity_type}:${member.entity_id}`"
        class="basket-row"
      >
        <button
          type="button"
          class="basket-row-body"
          :disabled="!target(member)"
          :aria-label="`Öffnen: ${member.title}`"
          @click="open(member)"
        >
          <div class="basket-row-title">{{ member.title }}</div>
          <div class="basket-row-meta">
            <span v-if="member.subtitle">{{ member.subtitle }}</span>
            <span v-if="member.date">{{ formatDate(member.date) }}</span>
            <span v-if="formatAmount(member)">{{ formatAmount(member) }}</span>
          </div>
        </button>
        <Button
          icon="pi pi-times"
          text
          rounded
          size="small"
          class="basket-row-remove"
          :aria-label="`Aus dem Basket nehmen: ${member.title}`"
          @click="basket.remove([member])"
        />
      </li>
    </slot>
  </template>
</template>

<style scoped>
.basket-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--p-text-muted-color);
}
</style>
