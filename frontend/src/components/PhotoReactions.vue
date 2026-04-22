<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Button from 'primevue/button'
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

async function load() {
  if (!props.photoId) return
  loading.value = true
  error.value = ''
  try {
    const c = await listComments(props.photoId)
    comments.value = c.comments
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

function canEdit(c: PhotoComment): boolean {
  return currentUserId.value !== null && c.author.id === currentUserId.value
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

    <div class="reactions__comments">
      <div
        v-for="c in comments"
        :key="c.id"
        class="reactions__comment"
      >
        <div class="reactions__comment-head">
          <strong>{{ c.author.name ?? 'Unbekannt' }}</strong>
          <span class="reactions__comment-time">
            {{ formatRelative(c.createdAt) }}
            <span v-if="c.editedAt" class="reactions__comment-edited">(bearbeitet)</span>
          </span>
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
          <div class="reactions__comment-body">{{ c.body }}</div>
          <div v-if="canEdit(c)" class="reactions__comment-actions">
            <Button
              icon="pi pi-pencil"
              severity="secondary"
              text
              rounded
              size="small"
              v-tooltip.top="'Bearbeiten'"
              @click="startEdit(c)"
            />
            <Button
              icon="pi pi-trash"
              severity="danger"
              text
              rounded
              size="small"
              v-tooltip.top="'Löschen'"
              @click="removeComment(c)"
            />
          </div>
        </template>
      </div>

      <div v-if="!loading && comments.length === 0" class="reactions__empty">
        Noch keine Kommentare.
      </div>
    </div>

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

.reactions__comment {
  background: var(--p-surface-ground);
  border-radius: 8px;
  padding: 0.45rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.reactions__comment-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.85em;
}

.reactions__comment-time {
  color: var(--p-text-muted-color);
  font-size: 0.9em;
}

.reactions__comment-edited {
  margin-left: 0.25em;
  font-style: italic;
}

.reactions__comment-body {
  font-size: 0.95em;
  white-space: pre-wrap;
  word-break: break-word;
}

.reactions__comment-actions {
  align-self: flex-end;
  display: flex;
  gap: 0.15rem;
}

.reactions__edit-textarea {
  width: 100%;
  font-size: 0.95em;
}

.reactions__edit-actions {
  align-self: flex-end;
  display: flex;
  gap: 0.2rem;
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
