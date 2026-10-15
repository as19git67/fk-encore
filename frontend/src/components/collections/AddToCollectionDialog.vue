<script setup lang="ts">
/**
 * "In Sammelmappe legen" for every type (#1548).
 *
 * Looks and behaves like the document dialog: the basket first (the quick
 * "set aside"), then the collections that can take these items — recently
 * used and starred on top — and a field to make a new one on the spot. A
 * collection typed for another kind is left out rather than offered and
 * refused.
 */
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import {
  ENTITY_LABELS,
  addAnyCollectionMembers,
  createAnyCollection,
  describeCounts,
  listAllCollections,
  type CollectionEntityType,
  type CollectionSummary,
  type MemberRef,
} from '../../api/collections'
import { useBasketStore } from '../../stores/basket'

const props = defineProps<{
  visible: boolean
  members: MemberRef[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'added', payload: { collectionId: number | null; name: string; count: number }): void
}>()

const basket = useBasketStore()
const collections = ref<CollectionSummary[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const search = ref('')
const newName = ref('')
const typed = ref(false)

const types = computed(() => [...new Set(props.members.map((m) => m.entity_type))])
/** The one type of what is being added, or null when it is mixed. */
const onlyType = computed<CollectionEntityType | null>(() => (types.value.length === 1 ? types.value[0]! : null))
const what = computed(() => {
  const counts: Partial<Record<CollectionEntityType, number>> = {}
  for (const m of props.members) counts[m.entity_type] = (counts[m.entity_type] ?? 0) + 1
  return describeCounts(counts)
})

const fitting = computed(() => {
  const term = search.value.trim().toLocaleLowerCase('de')
  return collections.value
    .filter((c) => c.entity_type === null || (onlyType.value !== null && c.entity_type === onlyType.value))
    .filter((c) => !term || c.name.toLocaleLowerCase('de').includes(term))
    .sort((a, b) => Number(b.favourite) - Number(a.favourite))
})

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    error.value = ''
    search.value = ''
    newName.value = ''
    typed.value = false
    void load()
  },
  { immediate: true },
)

async function load() {
  loading.value = true
  try {
    collections.value = (await listAllCollections({ sort: 'last_opened' })).items
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Sammelmappen konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

function done(collectionId: number | null, name: string) {
  emit('added', { collectionId, name, count: props.members.length })
  emit('update:visible', false)
}

function toBasket() {
  basket.add(props.members)
  done(null, 'Basket')
}

async function addTo(collection: CollectionSummary) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    await addAnyCollectionMembers(collection.id, props.members)
    done(collection.id, collection.name)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Hinzufügen fehlgeschlagen.'
  } finally {
    saving.value = false
  }
}

async function createAndAdd() {
  const name = newName.value.trim()
  if (!name || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const created = await createAnyCollection({
      name,
      entity_type: typed.value ? onlyType.value : null,
      members: props.members,
    })
    done(created.id, created.name)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    class="dialog-sm"
    :visible="visible"
    modal
    header="In Sammelmappe legen"
    @update:visible="emit('update:visible', $event)"
  >
    <p class="atc-lead">{{ what }} hinzufügen. Alles darf in mehreren Mappen liegen.</p>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <button type="button" class="atc-row atc-basket" :disabled="saving" data-testid="atc-basket" @click="toBasket">
      <span class="atc-title"><i class="pi pi-shopping-cart" /> In den Basket legen</span>
      <span class="atc-meta">{{ basket.count }} {{ basket.count === 1 ? 'Eintrag' : 'Einträge' }}</span>
    </button>

    <div class="atc-new">
      <InputText
        v-model="newName"
        placeholder="Neue Sammelmappe …"
        class="atc-input"
        aria-label="Name der neuen Sammelmappe"
        @keyup.enter="createAndAdd"
      />
      <Button icon="pi pi-plus" label="Anlegen" :disabled="!newName.trim()" :loading="saving" @click="createAndAdd" />
    </div>
    <label v-if="onlyType" class="atc-typed">
      <Checkbox v-model="typed" binary />
      <span>Neue Mappe nur für {{ ENTITY_LABELS[onlyType].plural }}</span>
    </label>

    <InputText
      v-if="collections.length > 6"
      v-model="search"
      placeholder="Sammelmappe suchen …"
      class="atc-search"
      aria-label="Sammelmappe suchen"
    />

    <ul v-if="fitting.length > 0" class="atc-list">
      <li v-for="c in fitting" :key="c.id">
        <button type="button" class="atc-row" :disabled="saving" @click="addTo(c)">
          <span class="atc-title">
            <i v-if="c.favourite" class="pi pi-star-fill" aria-label="Favorit" />
            {{ c.name }}
          </span>
          <span class="atc-meta">
            {{ describeCounts(c.counts) || 'leer' }}
            <i v-if="c.visibility === 'group'" class="pi pi-users" aria-label="Gruppe" />
          </span>
        </button>
      </li>
    </ul>
    <p v-else-if="!loading" class="atc-empty">
      {{ search.trim() ? 'Keine passende Sammelmappe.' : 'Noch keine passende Sammelmappe angelegt.' }}
    </p>
  </Dialog>
</template>

<style scoped>
.atc-lead {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-base);
}
.atc-basket {
  margin-bottom: var(--space-3);
}
.atc-new {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.atc-input,
.atc-search {
  flex: 1 1 auto;
  min-width: 0;
}
.atc-search {
  width: 100%;
  margin-bottom: var(--space-2);
}
.atc-typed {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.atc-list {
  list-style: none;
  padding: var(--focus-ring-reach);
  margin: calc(-1 * var(--focus-ring-reach));
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 45vh;
  overflow-y: auto;
}
.atc-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 10px 12px;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  background: var(--p-content-background);
  color: var(--p-text-color);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.atc-row:hover:not(:disabled) {
  background: var(--p-content-hover-background);
}
.atc-row:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.atc-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.atc-title i {
  margin-right: var(--space-1);
}
.atc-meta {
  flex: 0 0 auto;
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
}
.atc-meta i {
  margin-left: 6px;
}
.atc-empty {
  color: var(--p-text-muted-color);
  font-size: var(--text-base);
  margin: var(--space-2) 0 0;
}
</style>
