<script setup lang="ts" generic="T extends string | number">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'

export interface MultiSelectItem<TId> {
  id: TId
  label: string
}

const props = defineProps<{
  visible: boolean
  title: string
  items: MultiSelectItem<T>[]
  /**
   * Initial check state per item across the subject(s):
   *   true  = present on all subjects
   *   null  = present on some (indeterminate)
   *   false = present on none
   * Called only when the dialog opens — pending changes are derived
   * against this baseline.
   */
  initialState: (id: T) => boolean | null
  /** "5 Fotos" / "Dokument" — populated in the count line. */
  subjectCount?: number
  subjectLabel?: string
  saveLabel?: string
  allowCreate?: boolean
  createPlaceholder?: string
  createLabel?: string
  loading?: boolean
  saving?: boolean
  emptyMessage?: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'save', payload: { adds: T[]; removes: T[] }): void
  (e: 'create', name: string): void
}>()

const pending = ref<Map<T, 'add' | 'remove'>>(new Map())
const baseline = ref<Map<T, boolean | null>>(new Map())
const search = ref('')
const showCreate = ref(false)
const newName = ref('')
const creating = ref(false)
const errorMsg = ref<string | null>(null)

watch(
  () => props.visible,
  (open) => {
    if (open) {
      const map = new Map<T, boolean | null>()
      for (const it of props.items) map.set(it.id, props.initialState(it.id))
      baseline.value = map
      pending.value = new Map()
      search.value = ''
      showCreate.value = false
      newName.value = ''
      creating.value = false
      errorMsg.value = null
    }
  },
)

// Recompute the baseline when the parent finishes its async load.
// The synchronous open-watch above snapshots `initialState` immediately,
// which is too early when the parent still has data in flight (typical
// flow: open → fetch /photos/albums → tristate map populated). Watching
// the `loading` prop transition from true → false re-runs the snapshot
// once the parent's data is ready, without losing in-progress user
// edits because we only refresh items the user has not yet touched.
watch(
  () => props.loading,
  (now, prev) => {
    if (prev === true && now === false && props.visible) {
      const map = new Map<T, boolean | null>()
      for (const it of props.items) map.set(it.id, props.initialState(it.id))
      baseline.value = map
    }
  },
)

// Recompute baseline when items change while open (e.g. after creating a
// new entry and parent refreshes the list). Existing pending changes are
// preserved.
watch(
  () => props.items,
  () => {
    if (!props.visible) return
    const map = new Map<T, boolean | null>()
    for (const it of props.items) {
      const prev = baseline.value.get(it.id)
      map.set(it.id, prev !== undefined ? prev : props.initialState(it.id))
    }
    baseline.value = map
  },
  { deep: false },
)

function effectiveState(id: T): boolean | null {
  const p = pending.value.get(id)
  if (p === 'add') return true
  if (p === 'remove') return false
  return baseline.value.get(id) ?? false
}

function toggle(id: T, checked: boolean) {
  const original = baseline.value.get(id) ?? false
  if (checked === original) {
    pending.value.delete(id)
  } else {
    pending.value.set(id, checked ? 'add' : 'remove')
  }
  // Trigger reactivity for the Map.
  pending.value = new Map(pending.value)
}

const filteredItems = computed(() => {
  const q = search.value.trim().toLowerCase()
  const filtered = q
    ? props.items.filter((i) => i.label.toLowerCase().includes(q))
    : props.items
  return [...filtered].sort((a, b) => {
    const sa = effectiveState(a.id)
    const sb = effectiveState(b.id)
    const wa = sa === true ? 0 : sa === null ? 1 : 2
    const wb = sb === true ? 0 : sb === null ? 1 : 2
    if (wa !== wb) return wa - wb
    return a.label.localeCompare(b.label)
  })
})

const pendingCount = computed(() => pending.value.size)

const subjectMsg = computed(() => {
  if (props.subjectCount == null || !props.subjectLabel) return null
  return `Auf ${props.subjectCount} ${props.subjectLabel} anwenden`
})

function onSave() {
  const adds: T[] = []
  const removes: T[] = []
  for (const [id, action] of pending.value.entries()) {
    if (action === 'add') adds.push(id)
    else removes.push(id)
  }
  emit('save', { adds, removes })
}

async function onCreate() {
  const name = newName.value.trim()
  if (!name) return
  creating.value = true
  errorMsg.value = null
  try {
    emit('create', name)
    newName.value = ''
    showCreate.value = false
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

function onClose() {
  emit('update:visible', false)
}
</script>

<template>
  <Dialog
    :visible="visible"
    :modal="true"
    :closable="!saving"
    :style="{ width: '32rem' }"
    :breakpoints="{ '768px': '95vw' }"
    :header="title"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <p v-if="subjectMsg" class="subject-line">{{ subjectMsg }}</p>

    <div class="search-row">
      <i class="pi pi-search search-icon" />
      <InputText
        v-model="search"
        class="search-input"
        placeholder="Suchen…"
      />
    </div>

    <div v-if="loading" class="empty-row">
      <i class="pi pi-spin pi-spinner" /> Lade…
    </div>
    <div v-else-if="items.length === 0" class="empty-row">
      {{ emptyMessage || 'Keine Einträge.' }}
    </div>
    <div v-else-if="filteredItems.length === 0" class="empty-row">
      Keine Treffer.
    </div>
    <div v-else class="checkbox-list">
      <div
        v-for="item in filteredItems"
        :key="String(item.id)"
        class="checkbox-row"
      >
        <Checkbox
          :modelValue="effectiveState(item.id) === true"
          :indeterminate="effectiveState(item.id) === null"
          :binary="true"
          :inputId="`mss-${String(item.id)}`"
          @update:modelValue="(val: boolean) => toggle(item.id, val)"
        />
        <label :for="`mss-${String(item.id)}`">{{ item.label }}</label>
      </div>
    </div>

    <div v-if="allowCreate" class="create-row">
      <div v-if="showCreate" class="create-form">
        <InputText
          v-model="newName"
          class="create-input"
          :placeholder="createPlaceholder || 'Name…'"
          @keydown.enter.prevent="onCreate"
          @keydown.escape="showCreate = false; newName = ''"
        />
        <Button
          icon="pi pi-check"
          size="small"
          :loading="creating"
          :disabled="!newName.trim()"
          @click="onCreate"
        />
        <Button
          icon="pi pi-times"
          size="small"
          text
          :disabled="creating"
          @click="showCreate = false; newName = ''"
        />
      </div>
      <Button
        v-else
        :label="createLabel || 'Neuer Eintrag'"
        icon="pi pi-plus"
        size="small"
        text
        @click="showCreate = true"
      />
    </div>

    <Message v-if="errorMsg" severity="error" :closable="false" class="error-msg">
      {{ errorMsg }}
    </Message>

    <template #footer>
      <Button
        label="Abbrechen"
        severity="secondary"
        :disabled="saving"
        @click="onClose"
      />
      <Button
        :label="saveLabel || 'Speichern'"
        :loading="saving"
        :disabled="pendingCount === 0"
        @click="onSave"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.subject-line {
  margin: 0 0 0.75rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}

.search-row {
  position: relative;
  margin-bottom: 0.75rem;
}

.search-icon {
  position: absolute;
  left: 0.6rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--p-text-muted-color);
  pointer-events: none;
  font-size: 0.85rem;
}

.search-input {
  width: 100%;
  padding-left: 1.85rem;
}

.checkbox-list {
  max-height: 18rem;
  overflow-y: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  padding: 0.25rem;
  background: var(--p-content-hover-background);
}

.checkbox-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: 4px;
  font-size: 0.9rem;
}

.checkbox-row label {
  cursor: pointer;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-row {
  padding: 1rem 0.5rem;
  text-align: center;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}

.create-row {
  margin-top: 0.5rem;
}

.create-form {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}

.create-input {
  flex: 1;
  min-width: 0;
}

.error-msg {
  margin-top: 0.5rem;
}
</style>
