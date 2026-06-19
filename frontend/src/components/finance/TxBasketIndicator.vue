<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Badge from 'primevue/badge'
import Drawer from 'primevue/drawer'
import { useTxSelectionStore } from '../../stores/finance/selection'
import type { Transaction } from '../../api/finance'

/**
 * Header indicator + slide-out drawer for the transaction basket.
 *
 * Surfaces the current selection regardless of which view created it so
 * the user can review and act on it without going back to the list.
 * Mounted from App.vue's navbar-end only while the user is in the
 * finance module — other modules don't use the basket.
 */

const selectionStore = useTxSelectionStore()
const router = useRouter()
const drawerVisible = ref(false)

const count = computed(() => selectionStore.count)
const items = computed(() => selectionStore.items)

const sumLabel = computed(() => {
  if (count.value === 0) return ''
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: selectionStore.currency,
  }).format(selectionStore.sum)
})

function formatAmount(tx: Transaction): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: tx.currency_code,
  }).format(Number(tx.amount))
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function openBatchTagEditor() {
  drawerVisible.value = false
  void router.push({ name: 'finance-batch-tag' })
}
</script>

<template>
  <div class="basket-indicator">
    <Button
      v-tooltip.bottom="count === 0 ? 'Basket (leer)' : `Basket · ${count} Buchung${count === 1 ? '' : 'en'}`"
      icon="pi pi-shopping-cart"
      severity="secondary"
      text
      rounded
      aria-label="Basket öffnen"
      class="basket-button"
      @click="drawerVisible = true"
    >
      <Badge
        v-if="count > 0"
        :value="String(count)"
        severity="info"
        class="basket-badge"
      />
    </Button>

    <Drawer
      v-model:visible="drawerVisible"
      position="right"
      header="Basket"
      class="basket-drawer"
    >
      <template #header>
        <div class="drawer-header">
          <span class="drawer-title">Basket</span>
          <span v-if="count > 0" class="drawer-sum">{{ sumLabel }}</span>
        </div>
      </template>

      <div v-if="count === 0" class="basket-empty">
        <i class="pi pi-shopping-cart basket-empty-icon" />
        <p>Noch keine Buchungen im Basket.</p>
        <p class="hint">
          Lege Buchungen aus der Liste, der Detailansicht oder den Anomalien
          ab, um sie hier zu sammeln.
        </p>
      </div>

      <ul v-else class="basket-list">
        <li
          v-for="tx in items"
          :key="tx.id"
          class="basket-row"
        >
          <div class="basket-row-body">
            <div class="basket-row-head">
              <span class="basket-row-date">{{ formatDate(tx.booking_date) }}</span>
              <span
                class="basket-row-amount"
                :class="Number(tx.amount) < 0 ? 'amount-neg' : 'amount-pos'"
              >
                {{ formatAmount(tx) }}
              </span>
            </div>
            <div class="basket-row-name">
              {{ tx.counterparty ?? '—' }}
            </div>
            <div v-if="tx.purpose" class="basket-row-purpose">
              {{ tx.purpose }}
            </div>
          </div>
          <button
            type="button"
            class="basket-row-remove"
            :aria-label="`Aus Basket entfernen: ${tx.counterparty ?? tx.id}`"
            @click="selectionStore.remove(tx.id)"
          >
            <i class="pi pi-times-circle" />
          </button>
        </li>
      </ul>

      <template #footer>
        <div class="drawer-footer">
          <Button
            label="Alles leeren"
            icon="pi pi-times"
            severity="secondary"
            text
            size="small"
            :disabled="count === 0"
            @click="selectionStore.clear()"
          />
          <Button
            label="Tags"
            icon="pi pi-tag"
            size="small"
            :disabled="count === 0"
            @click="openBatchTagEditor"
          />
        </div>
      </template>
    </Drawer>
  </div>
</template>

<style scoped>
.basket-indicator {
  position: relative;
  display: inline-flex;
}

.basket-button :deep(.p-badge) {
  position: absolute;
  top: -0.15rem;
  right: -0.15rem;
  pointer-events: none;
}

.drawer-header {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}
.drawer-title {
  font-weight: 600;
  font-size: 1.05rem;
}
.drawer-sum {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
  font-size: 0.95rem;
}

.basket-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 2rem 1rem;
  color: var(--p-text-muted-color);
}
.basket-empty-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}
.basket-empty .hint {
  font-size: 0.85rem;
  margin-top: 0.25rem;
}

.basket-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}
.basket-row {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.6rem 0.25rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.basket-row:last-child {
  border-bottom: none;
}
.basket-row-body {
  flex: 1;
  min-width: 0;
}
.basket-row-head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.85rem;
}
.basket-row-date {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}
.basket-row-amount {
  font-family: monospace;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.amount-pos { color: var(--p-text-color); }
.amount-neg { color: var(--p-red-600, #c0392b); }
.basket-row-name {
  margin-top: 0.15rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.basket-row-purpose {
  margin-top: 0.1rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.basket-row-remove {
  background: none;
  border: none;
  padding: 0.25rem;
  cursor: pointer;
  color: var(--p-text-muted-color);
  border-radius: 0.25rem;
  flex-shrink: 0;
}
.basket-row-remove:hover {
  color: var(--p-text-color);
  background: var(--p-content-hover-background);
}

.drawer-footer {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}
</style>
