<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Button from 'primevue/button'
import Popover from 'primevue/popover'
import {
  createComment,
  deleteComment,
  listComments,
  updateComment,
  type PhotoComment,
} from '../api/reactions'
import { useAuthStore } from '../stores/auth'
import { useRealtimeEvent } from '../composables/useRealtime'

const props = defineProps<{
  photoId: number
}>()

const auth = useAuthStore()
const currentUserId = computed(() => auth.user?.id ?? null)

const comments = ref<PhotoComment[]>([])
const loading = ref(false)
const error = ref('')

const commentInput = ref('')
const submitting = ref(false)
const editingId = ref<number | null>(null)
const editingText = ref('')

// One shared popover serves as the action menu for the currently tapped
// own-comment bubble. `actionTarget` tracks which comment the menu applies to.
const actionPopover = ref<InstanceType<typeof Popover> | null>(null)
const actionTarget = ref<PhotoComment | null>(null)

function openActions(event: Event, c: PhotoComment) {
  if (editingId.value === c.id) return
  actionTarget.value = c
  actionPopover.value?.show(event)
}

function closeActions() {
  actionPopover.value?.hide()
  actionTarget.value = null
}

function handleEditFromMenu() {
  const c = actionTarget.value
  closeActions()
  if (c) startEdit(c)
}

function handleDeleteFromMenu() {
  const c = actionTarget.value
  closeActions()
  if (c) void removeComment(c)
}

// Scroll container for the comment list. Kept at the bottom (newest
// comment visible) after every content change so the user always
// lands on the most recent message — mirrors the chat-style UX.
const commentsRef = ref<HTMLElement | null>(null)

async function scrollToLatest(): Promise<void> {
  await nextTick()
  const el = commentsRef.value
  if (el) el.scrollTop = el.scrollHeight
}

async function load() {
  if (!props.photoId) return
  loading.value = true
  error.value = ''
  try {
    const c = await listComments(props.photoId)
    comments.value = c.comments
    await scrollToLatest()
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Fehler beim Laden'
  } finally {
    loading.value = false
  }
}

async function submitComment() {
  const body = commentInput.value.trim()
  if (!body || submitting.value) return
  submitting.value = true
  try {
    const created = await createComment(props.photoId, body)
    comments.value.push(created)
    commentInput.value = ''
    await scrollToLatest()
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Kommentar fehlgeschlagen'
  } finally {
    submitting.value = false
  }
}

function startEdit(c: PhotoComment) {
  editingId.value = c.id
  editingText.value = c.body
}

function cancelEdit() {
  editingId.value = null
  editingText.value = ''
}

async function saveEdit(c: PhotoComment) {
  const body = editingText.value.trim()
  if (!body) return
  try {
    const updated = await updateComment(c.id, body)
    const idx = comments.value.findIndex((x) => x.id === c.id)
    if (idx >= 0) comments.value[idx] = updated
    cancelEdit()
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Speichern fehlgeschlagen'
  }
}

async function removeComment(c: PhotoComment) {
  if (!confirm('Kommentar wirklich löschen?')) return
  try {
    await deleteComment(c.id)
    comments.value = comments.value.filter((x) => x.id !== c.id)
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Löschen fehlgeschlagen'
  }
}

// Edit is only offered when the user's comment is *the* latest in
// the thread. Once anyone else has replied the conversation has moved
// on and prior entries stay frozen so we never rewrite a line that
// someone has already reacted to. Delete remains available on every
// own comment.
const lastCommentId = computed<number | null>(() => {
  if (comments.value.length === 0) return null
  return comments.value[comments.value.length - 1]?.id ?? null
})

function isOwn(c: PhotoComment): boolean {
  return currentUserId.value !== null && c.author.id === currentUserId.value
}

function canEdit(c: PhotoComment): boolean {
  return isOwn(c) && c.id === lastCommentId.value
}

function canDelete(c: PhotoComment): boolean {
  return isOwn(c)
}

function formatRelative(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diff = Date.now() - d.getTime()
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `vor ${h} h`
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

// Live updates: react to events on the `photos` channel for this photo.
// useRealtimeEvent self-manages its own mount/unmount lifecycle.
function matchesPhoto(resourceId: string | number): boolean {
  return Number(resourceId) === props.photoId
}

async function refreshComments() {
  try {
    const c = await listComments(props.photoId)
    comments.value = c.comments
    await scrollToLatest()
  } catch {
    // Ignore — next open will re-sync.
  }
}

useRealtimeEvent('photos', 'commented', (ev) => {
  if (matchesPhoto(ev.resourceId)) void refreshComments()
})

useRealtimeEvent('photos', 'comment_updated', (ev) => {
  if (matchesPhoto(ev.resourceId)) void refreshComments()
})

useRealtimeEvent('photos', 'comment_deleted', (ev) => {
  if (!matchesPhoto(ev.resourceId)) return
  const commentId = Number(ev.payload?.commentId)
  if (Number.isFinite(commentId)) {
    comments.value = comments.value.filter((x) => x.id !== commentId)
  }
})

watch(
  () => props.photoId,
  () => {
    void nextTick(load)
  },
  { immediate: true },
)
</script>

<template>
  <div class="reactions">
    <div v-if="error" class="reactions__error">{{ error }}</div>

    <div ref="commentsRef" class="reactions__comments">
      <div
        v-for="c in comments"
        :key="c.id"
        :class="['reactions__row', isOwn(c) ? 'is-own' : 'is-other']"
      >
        <div
          :class="[
            'reactions__bubble',
            {
              'reactions__bubble--actionable':
                isOwn(c) && editingId !== c.id && (canEdit(c) || canDelete(c)),
            },
          ]"
          :role="isOwn(c) && editingId !== c.id && (canEdit(c) || canDelete(c)) ? 'button' : undefined"
          :tabindex="isOwn(c) && editingId !== c.id && (canEdit(c) || canDelete(c)) ? 0 : undefined"
          :aria-haspopup="isOwn(c) && editingId !== c.id && (canEdit(c) || canDelete(c)) ? 'menu' : undefined"
          :title="isOwn(c) && editingId !== c.id && (canEdit(c) || canDelete(c)) ? 'Aktionen' : undefined"
          @click="isOwn(c) && editingId !== c.id && (canEdit(c) || canDelete(c)) && openActions($event, c)"
          @keydown.enter.prevent="isOwn(c) && editingId !== c.id && (canEdit(c) || canDelete(c)) && openActions($event, c)"
          @keydown.space.prevent="isOwn(c) && editingId !== c.id && (canEdit(c) || canDelete(c)) && openActions($event, c)"
        >
          <div v-if="!isOwn(c)" class="reactions__author">
            {{ c.author.name ?? 'Unbekannt' }}
          </div>
          <template v-if="editingId === c.id">
            <textarea
              v-model="editingText"
              class="p-inputtext reactions__edit-textarea"
              rows="2"
            />
            <div class="reactions__edit-actions">
              <Button
                icon="pi pi-check"
                severity="success"
                text
                rounded
                size="small"
                @click="saveEdit(c)"
              />
              <Button
                icon="pi pi-times"
                severity="secondary"
                text
                rounded
                size="small"
                @click="cancelEdit"
              />
            </div>
          </template>
          <template v-else>
            <div class="reactions__body">{{ c.body }}</div>
            <div class="reactions__meta">
              <span>{{ formatRelative(c.createdAt) }}</span>
              <span v-if="c.editedAt" class="reactions__edited">(bearbeitet)</span>
            </div>
          </template>
        </div>
      </div>

      <div v-if="!loading && comments.length === 0" class="reactions__empty">
        Noch keine Kommentare.
      </div>
    </div>

    <Popover ref="actionPopover">
      <div class="reactions__menu">
        <button
          v-if="actionTarget && canEdit(actionTarget)"
          type="button"
          class="reactions__menu-item"
          @click="handleEditFromMenu"
        >
          <i class="pi pi-pencil" /> Ändern
        </button>
        <button
          v-if="actionTarget && canDelete(actionTarget)"
          type="button"
          class="reactions__menu-item reactions__menu-item--danger"
          @click="handleDeleteFromMenu"
        >
          <i class="pi pi-trash" /> Löschen
        </button>
      </div>
    </Popover>

    <form class="reactions__composer" @submit.prevent="submitComment">
      <textarea
        v-model="commentInput"
        class="p-inputtext reactions__composer-textarea"
        rows="2"
        placeholder="Kommentar schreiben…"
        :disabled="submitting"
      />
      <Button
        type="submit"
        icon="pi pi-send"
        severity="primary"
        :disabled="!commentInput.trim() || submitting"
        :loading="submitting"
        v-tooltip.top="'Senden'"
      />
    </form>
  </div>
</template>

<style scoped>
.reactions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.reactions__error {
  color: var(--p-message-error-color, #c00);
  font-size: 0.85em;
}

.reactions__comments {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 320px;
  overflow-y: auto;
}

.reactions__row {
  display: flex;
  font-size: 0.8em;
}
.reactions__row.is-own {
  justify-content: flex-end;
}
.reactions__row.is-other {
  justify-content: flex-start;
}

.reactions__bubble {
  max-width: 82%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.4rem 0.6rem;
  border-radius: 14px;
  word-break: break-word;
}
.reactions__bubble--actionable {
  cursor: pointer;
}
.reactions__bubble--actionable:hover,
.reactions__bubble--actionable:focus-visible {
  filter: brightness(0.95);
  outline: none;
}
.is-other .reactions__bubble {
  background: var(--p-surface-200, #e5e7eb);
  color: var(--p-text-color);
  border-bottom-left-radius: 4px;
}
.is-own .reactions__bubble {
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color, #fff);
  border-bottom-right-radius: 4px;
}

.reactions__author {
  font-size: 0.85em;
  font-weight: 600;
  color: var(--p-text-muted-color);
}

.reactions__body {
  white-space: pre-wrap;
}

.reactions__meta {
  display: flex;
  gap: 0.35em;
  font-size: 0.8em;
  opacity: 0.75;
  align-self: flex-end;
}
.is-other .reactions__meta {
  align-self: flex-start;
}

.reactions__edited {
  font-style: italic;
}

.reactions__edit-textarea {
  width: 100%;
  font-size: 0.85em;
}

.reactions__edit-actions {
  align-self: flex-end;
  display: flex;
  gap: 0.2rem;
}

.reactions__menu {
  display: flex;
  flex-direction: column;
  min-width: 140px;
}
.reactions__menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: transparent;
  border: none;
  font: inherit;
  color: var(--p-text-color);
  cursor: pointer;
  text-align: left;
  border-radius: 4px;
}
.reactions__menu-item:hover,
.reactions__menu-item:focus-visible {
  background: var(--p-surface-100, #f3f4f6);
  outline: none;
}
.reactions__menu-item--danger {
  color: var(--p-red-500, #ef4444);
}

.reactions__empty {
  color: var(--p-text-muted-color);
  font-size: 0.85em;
  font-style: italic;
}

.reactions__composer {
  display: flex;
  gap: 0.4rem;
  align-items: flex-start;
}

.reactions__composer-textarea {
  flex: 1;
  min-width: 0;
  resize: vertical;
}
</style>
