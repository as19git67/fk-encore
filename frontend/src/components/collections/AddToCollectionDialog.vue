<script setup lang="ts">
import { searchInputAttrs } from '../../utils/searchInputAttrs'
/**
 * "Ablegen" — the one way to put things into the basket or a collection
 * (#1548). Every list and every detail page opens this same dialog.
 *
 * The basket comes first, one click away. Then the collections that can
 * take these items, starred and recently used ones on top, and a field to
 * make a new one on the spot.
 *
 * For a single item the dialog also says where it already lies — a check
 * mark on the basket and on each collection holding it — and a click takes
 * it out again; the dialog stays open, so filing one item in several places
 * is several clicks, not several dialogs. For a selection it puts in and
 * closes.
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
  collectionsOfItem,
  createAnyCollection,
  createCollection,
  describeCounts,
  listAllCollections,
  removeAnyCollectionMember,
  type CollectionEntityType,
  type CollectionMember,
  type CollectionRuleInput,
  type CollectionSummary,
  type MemberRef,
} from '../../api/collections'
import { useBasketStore } from '../../stores/basket'

const props = defineProps<{
  visible: boolean
  members: MemberRef[]
  /** How the item is called in the basket before the server names it (single item). */
  title?: string
  /**
   * Put into / take out of the basket the module's way, when the module holds
   * whole objects (transactions, documents). Defaults to the shared basket.
   */
  basket?: { add: () => void; remove: () => void }
  /** Documents: a new folder can be a dossier whose rule is seeded from this (#1480). */
  dossierSeed?: CollectionRuleInput | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'added', payload: { collectionId: number | null; name: string; title: string; count: number }): void
  (e: 'changed'): void
}>()

const basketStore = useBasketStore()
const collections = ref<CollectionSummary[]>([])
const holding = ref<Set<number>>(new Set())
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const search = ref('')
const newName = ref('')
// Things of one kind make a folder of that kind by default: a document
// folder keeps its own page with a manual order, a mixed one does not.
const typed = ref(true)
const asDossier = ref(false)

const single = computed(() => props.members.length === 1)
const types = computed(() => [...new Set(props.members.map((m) => m.entity_type))])
const onlyType = computed<CollectionEntityType | null>(() => (types.value.length === 1 ? types.value[0]! : null))
const what = computed(() => {
  const counts: Partial<Record<CollectionEntityType, number>> = {}
  for (const m of props.members) counts[m.entity_type] = (counts[m.entity_type] ?? 0) + 1
  return describeCounts(counts)
})
const inBasket = computed(() => single.value && basketStore.has(props.members[0]!))
const seedUsable = computed(() => {
  const s = props.dossierSeed
  return onlyType.value === 'document' && !!s &&
    (!!s.correspondent_slug || (s.reference_numbers?.length ?? 0) > 0 || !!s.source_folder_prefix)
})

const fitting = computed(() => {
  const term = search.value.trim().toLocaleLowerCase('de')
  return collections.value
    .filter((c) => c.kind !== 'rule')
    .filter((c) => c.entity_type === null || (onlyType.value !== null && c.entity_type === onlyType.value))
    .filter((c) => !term || c.name.toLocaleLowerCase('de').includes(term))
    .sort((a, b) => Number(holding.value.has(b.id)) - Number(holding.value.has(a.id)) || Number(b.favourite) - Number(a.favourite))
})

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    error.value = ''
    search.value = ''
    newName.value = ''
    typed.value = true
    asDossier.value = false
    void basketStore.load()
    void load()
  },
  { immediate: true },
)

async function load() {
  loading.value = true
  try {
    const [list, of] = await Promise.all([
      listAllCollections({ sort: 'last_opened' }),
      single.value ? collectionsOfItem(props.members[0]!) : Promise.resolve({ items: [] }),
    ])
    collections.value = list.items
    holding.value = new Set(of.items.map((c) => c.id))
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Sammelmappen konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

function finished(collectionId: number | null, name: string) {
  emit('added', { collectionId, name, title: name, count: props.members.length })
  emit('changed')
  if (!single.value) emit('update:visible', false)
}

function toggleBasket() {
  if (single.value && inBasket.value) {
    if (props.basket) props.basket.remove()
    else basketStore.remove(props.members)
    emit('changed')
    return
  }
  if (props.basket) props.basket.add()
  else basketStore.add(props.members.map((m) => ({ ...m, display: props.title ? ({ title: props.title } as Partial<CollectionMember>) : undefined })))
  finished(null, 'Basket')
}

async function toggle(collection: CollectionSummary) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    if (single.value && holding.value.has(collection.id)) {
      await removeAnyCollectionMember(collection.id, props.members[0]!)
      holding.value = new Set([...holding.value].filter((id) => id !== collection.id))
      emit('changed')
    } else {
      await addAnyCollectionMembers(collection.id, props.members)
      holding.value = new Set([...holding.value, collection.id])
      finished(collection.id, collection.name)
    }
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Ablegen fehlgeschlagen.'
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
    let id: number
    if (asDossier.value && seedUsable.value) {
      const created = await createCollection({
        title: name,
        document_ids: props.members.map((m) => m.entity_id),
        kind: 'dossier',
        rule: props.dossierSeed,
      })
      id = created.id
    } else {
      const created = await createAnyCollection({
        name,
        entity_type: typed.value ? onlyType.value : null,
        members: props.members,
      })
      id = created.id
    }
    newName.value = ''
    await load()
    finished(id, name)
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
    header="Ablegen"
    @update:visible="emit('update:visible', $event)"
  >
    <p class="atc-lead">
      {{ what }}
      {{ single ? '– in den Basket oder in Sammelmappen. Ein Klick legt hinein oder nimmt heraus.' : '– in den Basket oder in eine Sammelmappe.' }}
    </p>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <button
      type="button"
      class="atc-row atc-basket"
      :class="{ 'atc-row--in': inBasket }"
      :disabled="saving"
      :aria-pressed="single ? inBasket : undefined"
      data-testid="atc-basket"
      @click="toggleBasket"
    >
      <span class="atc-title">
        <i :class="inBasket ? 'pi pi-check-circle' : 'pi pi-cart-plus'" aria-hidden="true" />
        {{ inBasket ? 'Im Basket' : 'In den Basket' }}
      </span>
      <span class="atc-meta">{{ basketStore.count }} {{ basketStore.count === 1 ? 'Eintrag' : 'Einträge' }}</span>
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
    <label v-if="seedUsable" class="atc-typed">
      <Checkbox v-model="asDossier" binary />
      <span>Als Akte anlegen: Korrespondent, Referenznummern und Herkunftsordner werden zur Regel</span>
    </label>
    <label v-if="onlyType && !(seedUsable && asDossier)" class="atc-typed">
      <Checkbox v-model="typed" binary />
      <span>Neue Mappe nur für {{ ENTITY_LABELS[onlyType].plural }}</span>
    </label>

    <InputText v-bind="searchInputAttrs"
      v-if="collections.length > 6"
      v-model="search"
      placeholder="Sammelmappe suchen …"
      class="atc-search"
      aria-label="Sammelmappe suchen"
    />

    <ul v-if="fitting.length > 0" class="atc-list">
      <li v-for="c in fitting" :key="c.id">
        <button
          type="button"
          class="atc-row"
          :class="{ 'atc-row--in': holding.has(c.id) }"
          :disabled="saving"
          :aria-pressed="single ? holding.has(c.id) : undefined"
          @click="toggle(c)"
        >
          <span class="atc-title">
            <i :class="holding.has(c.id) ? 'pi pi-check-circle' : c.favourite ? 'pi pi-star-fill' : 'pi pi-folder'" aria-hidden="true" />
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

    <template #footer>
      <Button label="Fertig" severity="secondary" text @click="emit('update:visible', false)" />
    </template>
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
  align-items: flex-start;
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
.atc-row--in {
  border-color: var(--p-primary-color);
}
.atc-row--in .atc-title i {
  color: var(--p-primary-color);
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
