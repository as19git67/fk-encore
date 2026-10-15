<script setup lang="ts">
/**
 * The basket for modules without a drawer of their own (#1548): photos,
 * meters and the rest.
 *
 * Documents and finance keep their drawers, which do more with their kind
 * (batch tags, sums). Here every member of the shared basket is one row with
 * its type, title and date, grouped by type; the footer names the pile as a
 * collection or empties it.
 */
import { computed, ref } from 'vue'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import Button from 'primevue/button'
import BasketIndicator from '../BasketIndicator.vue'
import SaveBasketDialog from './SaveBasketDialog.vue'
import {
  ENTITY_LABELS,
  type CollectionEntityType,
  type CollectionMember,
} from '../../api/collections'
import { useBasketStore } from '../../stores/basket'
import { parseLocalDate } from '../../utils/dateFormat'

const basket = useBasketStore()
// App.vue loads it on sign-in; asking again is free and keeps this usable alone.
void basket.load()
const router = useRouter()
const confirm = useConfirm()
const saveOpen = ref(false)
const info = ref<string | null>(null)
const error = ref<string | null>(null)

const ORDER = Object.keys(ENTITY_LABELS) as CollectionEntityType[]

const groups = computed(() =>
  ORDER.map((type) => ({
    type,
    label: ENTITY_LABELS[type],
    members: basket.members.filter((m) => m.entity_type === type),
  })).filter((group) => group.members.length > 0),
)

/** Where a member opens, when its type has a page of its own. */
function target(member: CollectionMember): RouteLocationRaw | null {
  switch (member.entity_type) {
    case 'document':
      return { name: 'dokumente-detail', params: { id: member.entity_id } }
    case 'transaction':
      return { name: 'finance-transaction-detail', params: { id: member.entity_id } }
    case 'photo':
      return { name: 'fotos-gallery', query: { photoId: member.entity_id } }
    case 'album':
      return { name: 'fotos-album-detail', params: { id: member.entity_id } }
    case 'meter':
      return { name: 'zaehler-detail', params: { id: member.entity_id } }
    default:
      return null
  }
}

function open(member: CollectionMember) {
  const to = target(member)
  if (to) void router.push(to)
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

function confirmClear() {
  confirm.require({
    header: 'Basket leeren?',
    message: `Alle ${basket.count} Einträge werden aus dem Basket genommen. Die Dinge selbst bleiben erhalten.`,
    icon: 'pi pi-exclamation-triangle',
    acceptLabel: 'Leeren',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: () => {
      void basket.clear()
    },
  })
}
</script>

<template>
  <BasketIndicator
    :count="basket.count"
    singular="Eintrag"
    plural="Einträge"
    empty-hint="Fotos, Dokumente, Buchungen und Zähler lassen sich aus jeder Liste und Detailseite in den Basket legen."
    v-model:info="info"
    v-model:error="error"
  >
    <template #rows>
      <template v-for="group in groups" :key="group.type">
        <li class="shared-basket-group" aria-hidden="true">
          <i :class="group.label.icon" />
          {{ group.members.length === 1 ? group.label.singular : group.label.plural }}
          ({{ group.members.length }})
        </li>
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
      </template>
    </template>
    <template #footer>
      <div class="shared-basket-footer">
      <Button label="Leeren" severity="danger" text icon="pi pi-trash" @click="confirmClear" />
      <span class="shared-basket-spacer" />
      <Button
        label="Als Sammelmappe speichern"
        icon="pi pi-folder"
        data-testid="shared-basket-save"
        @click="saveOpen = true"
      />
      </div>
    </template>
  </BasketIndicator>
  <SaveBasketDialog
    v-model:visible="saveOpen"
    @saved="(c) => (info = `Sammelmappe „${c.name}“ angelegt.`)"
  />
</template>

<style scoped>
.shared-basket-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--p-text-muted-color);
}
.shared-basket-footer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.shared-basket-spacer {
  flex: 1 1 auto;
}
</style>
