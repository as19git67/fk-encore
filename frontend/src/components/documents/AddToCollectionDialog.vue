<script setup lang="ts">
/**
 * "In Sammelmappe legen" — from the document list, the basket, or a detail view.
 *
 * Either picks an existing folder or creates one on the spot, because the
 * moment a user decides several documents belong together is usually the
 * moment the folder should come into existence.
 */
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import {
  addCollectionDocuments,
  createCollection,
  listCollections,
  type DocumentCollection,
} from '../../api/collections'

const props = defineProps<{
  visible: boolean
  /** Documents to put in, in the order they should appear. */
  documentIds: number[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'added', payload: { collectionId: number; title: string; count: number }): void
}>()

const collections = ref<DocumentCollection[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const newTitle = ref('')

const count = computed(() => props.documentIds.length)

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    error.value = ''
    newTitle.value = ''
    void load()
  },
  { immediate: true },
)

async function load() {
  loading.value = true
  try {
    collections.value = (await listCollections()).items
  } catch (err: any) {
    error.value = err?.message ?? 'Sammelmappen konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

async function addTo(collection: DocumentCollection) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    await addCollectionDocuments(collection.id, props.documentIds)
    emit('added', { collectionId: collection.id, title: collection.title, count: count.value })
    emit('update:visible', false)
  } catch (err: any) {
    error.value = err?.message ?? 'Hinzufügen fehlgeschlagen.'
  } finally {
    saving.value = false
  }
}

async function createAndAdd() {
  const title = newTitle.value.trim()
  if (!title || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const created = await createCollection({ title, document_ids: props.documentIds })
    emit('added', { collectionId: created.id, title: created.title, count: count.value })
    emit('update:visible', false)
  } catch (err: any) {
    error.value = err?.message ?? 'Anlegen fehlgeschlagen.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="In Sammelmappe legen"
    :style="{ width: 'min(520px, 94vw)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <p class="atc-lead">
      {{ count }} {{ count === 1 ? 'Dokument' : 'Dokumente' }} hinzufügen.
      Ein Dokument darf in mehreren Mappen liegen.
    </p>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="atc-new">
      <InputText
        v-model="newTitle"
        placeholder="Neue Sammelmappe …"
        class="atc-input"
        @keyup.enter="createAndAdd"
      />
      <Button
        icon="pi pi-plus"
        label="Anlegen"
        :disabled="!newTitle.trim()"
        :loading="saving"
        @click="createAndAdd"
      />
    </div>

    <ul v-if="collections.length > 0" class="atc-list">
      <li v-for="c in collections" :key="c.id">
        <button type="button" class="atc-row" :disabled="saving" @click="addTo(c)">
          <span class="atc-title">{{ c.title }}</span>
          <span class="atc-meta">
            {{ c.item_count }} {{ c.item_count === 1 ? 'Dokument' : 'Dokumente' }}
            <i v-if="c.visibility === 'group'" class="pi pi-users" />
          </span>
        </button>
      </li>
    </ul>
    <p v-else-if="!loading" class="atc-empty">Noch keine Sammelmappe angelegt.</p>
  </Dialog>
</template>

<style scoped>
.atc-lead {
  margin: 0 0 12px;
  color: var(--p-text-muted-color);
  font-size: 0.86rem;
}
.atc-new {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.atc-input {
  flex: 1 1 auto;
  min-width: 0;
}
.atc-list {
  list-style: none;
  margin: 0;
  padding: 0;
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
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  background: var(--p-content-background);
  color: var(--p-text-color);
  cursor: pointer;
  text-align: left;
}
.atc-row:hover:not(:disabled) {
  background: var(--p-content-hover-background);
}
.atc-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.atc-meta {
  flex: 0 0 auto;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
.atc-meta i {
  margin-left: 6px;
}
.atc-empty {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  margin: 0;
}
</style>
