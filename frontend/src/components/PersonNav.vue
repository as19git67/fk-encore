<script setup lang="ts">
import { ref, nextTick, type ComponentPublicInstance } from 'vue'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import { getPhotoUrl, type Person, type FaceBBox } from '../api/photos'

const props = defineProps<{
  persons: Person[]
  selectedPerson: Person | null
}>()

const emit = defineEmits<{
  'update:selectedPerson': [person: Person]
  'rename': [person: Person]
  'ignore': [person: Person]
}>()

// ── Inline rename state ──────────────────────────────────────────────────────
const inlineRenamePersonId = ref<number | null>(null)
const inlineRenameValue = ref('')
const inlineRenameSaving = ref(false)
const inlineRenameInputRef = ref<HTMLInputElement | null>(null)

function setInlineRenameInputRef(el: Element | ComponentPublicInstance | null) {
  inlineRenameInputRef.value = el instanceof HTMLInputElement ? el : null
}

function startInlineRename(person: Person) {
  if (inlineRenameSaving.value) return
  inlineRenamePersonId.value = person.id
  inlineRenameValue.value = person.name === 'Unbenannt' ? '' : person.name
  void nextTick(() => {
    inlineRenameInputRef.value?.focus()
    inlineRenameInputRef.value?.select()
  })
}

function cancelInlineRename() {
  if (inlineRenameSaving.value) return
  inlineRenamePersonId.value = null
  inlineRenameValue.value = ''
}

async function submitInlineRename() {
  if (inlineRenamePersonId.value == null || inlineRenameSaving.value) return
  const person = props.persons.find(p => p.id === inlineRenamePersonId.value)
  if (!person) { cancelInlineRename(); return }
  const trimmed = inlineRenameValue.value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'unbenannt') return
  if (trimmed === person.name.trim()) { cancelInlineRename(); return }
  inlineRenameSaving.value = true
  // Delegate full rename/merge logic to parent via emit
  emit('rename', { ...person, name: trimmed })
  inlineRenameSaving.value = false
  inlineRenamePersonId.value = null
  inlineRenameValue.value = ''
}

// ── Cover image helpers ──────────────────────────────────────────────────────
function getCoverUrl(person: Person) {
  if (person.cover_filename) return getPhotoUrl(person.cover_filename, 200)
  return 'https://www.primefaces.org/wp-content/uploads/2020/05/placeholder.png'
}

function validBbox(bbox: FaceBBox | undefined | null): FaceBBox | null {
  if (!bbox) return null
  if (bbox.x > 1.1 || bbox.y > 1.1) return null
  return bbox
}

function thumbnailZoom(bbox: FaceBBox | undefined | null): number {
  const b = validBbox(bbox)
  if (!b) return 1
  return Math.min(4, Math.max(1.5, 0.4 / Math.max(b.width, b.height)))
}

function thumbnailImageStyle(bbox: FaceBBox | undefined | null): Record<string, string> {
  const b = validBbox(bbox)
  if (!b) return {}
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const zoom = thumbnailZoom(bbox)
  return {
    objectPosition: `${(cx * 100).toFixed(1)}% ${(cy * 100).toFixed(1)}%`,
    transform: `scale(${zoom.toFixed(2)}) translate(${((0.5 - cx) * 100).toFixed(1)}%, ${((0.5 - cy) * 100).toFixed(1)}%)`,
    transformOrigin: '50% 50%',
  }
}

// ── Touch handling (prevent iOS two-tap focus-then-click issue) ──────────────
let touchStartY = 0

function onEntryTouchStart(e: TouchEvent) {
  touchStartY = e.touches[0]?.clientY ?? 0
}

function onEntryTouchEnd(e: TouchEvent, person: Person) {
  const dy = Math.abs((e.changedTouches[0]?.clientY ?? 0) - touchStartY)
  if (dy < 10) {
    e.preventDefault()
    emit('update:selectedPerson', person)
  }
}

// ── Keyboard nav (↑/↓ within the list) ──────────────────────────────────────
function getEntries(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.person-entry[tabindex]'))
}

function navigateUp() {
  const idx = props.persons.findIndex(p => p.id === props.selectedPerson?.id)
  if (idx > 0) {
    emit('update:selectedPerson', props.persons[idx - 1]!)
    void nextTick(() => getEntries()[idx - 1]?.focus())
  }
}

function navigateDown() {
  const idx = props.persons.findIndex(p => p.id === props.selectedPerson?.id)
  if (idx < props.persons.length - 1) {
    emit('update:selectedPerson', props.persons[idx + 1]!)
    void nextTick(() => getEntries()[idx + 1]?.focus())
  }
}

defineExpose({ navigateUp, navigateDown })
</script>

<template>
  <nav class="person-panel">
    <div
      v-for="person in persons"
      :key="person.id"
      class="person-entry"
      tabindex="0"
      :class="{ active: selectedPerson?.id === person.id }"
      @click="emit('update:selectedPerson', person)"
      @touchstart.passive="onEntryTouchStart"
      @touchend="onEntryTouchEnd($event, person)"
    >
      <div class="person-avatar">
        <HeicImage
          :src="getCoverUrl(person)"
          :alt="person.name"
          objectFit="cover"
          :imageStyle="thumbnailImageStyle(person.cover_bbox)"
        />
      </div>
      <div class="person-entry-info">
        <div v-if="inlineRenamePersonId === person.id" class="rename-inline" @click.stop @touchend.stop>
          <input
            :ref="setInlineRenameInputRef"
            v-model="inlineRenameValue"
            class="rename-input"
            type="text"
            autocomplete="off"
            :disabled="inlineRenameSaving"
            @keydown.enter.prevent.stop="submitInlineRename"
            @keydown.esc.prevent.stop="cancelInlineRename"
          />
          <Button
            icon="pi pi-check" text rounded size="small"
            :disabled="inlineRenameSaving || !inlineRenameValue.trim() || inlineRenameValue.trim().toLowerCase() === 'unbenannt'"
            @click.stop="submitInlineRename"
          />
          <Button icon="pi pi-times" text rounded size="small" :disabled="inlineRenameSaving" @click.stop="cancelInlineRename" />
        </div>
        <template v-else>
          <span class="person-entry-name">{{ person.name }}</span>
          <span class="person-entry-count">{{ person.faceCount }} Fotos</span>
        </template>
      </div>
      <Button
        v-if="inlineRenamePersonId !== person.id"
        class="pencil-btn"
        icon="pi pi-pencil"
        text rounded size="small"
        tabindex="-1"
        @click.stop="startInlineRename(person)"
        @touchend.stop
      />
    </div>
  </nav>
</template>

<style scoped>
.person-panel {
  width: 200px;
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--p-content-background);
  border-right: 1px solid var(--p-content-border-color);
  display: flex;
  flex-direction: column;
  gap: 0;
}

.person-entry {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.15s;
  outline: none;
  position: relative;
}

.person-entry:hover { background: var(--p-content-hover-background); }
.person-entry:hover .pencil-btn { opacity: 1; }
.person-entry.active {
  background: var(--p-primary-50);
  border-left-color: var(--p-primary-color);
}

.person-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
}

.person-entry-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.person-entry-name {
  font-size: 0.85rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.person-entry-count {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}

.pencil-btn {
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}

.rename-inline {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex: 1;
}

.rename-input {
  flex: 1;
  min-width: 0;
  font-size: 0.8rem;
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 4px;
  background: var(--p-content-background);
  color: var(--p-text-color);
}
</style>
