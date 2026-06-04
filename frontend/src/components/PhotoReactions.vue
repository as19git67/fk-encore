<script setup lang="ts">
/**
 * User-app photo comments. Owns data fetching + realtime sync, then
 * delegates rendering to the shared PhotoCommentThread base which the
 * guest variant on the public share page also uses.
 */

import { computed, nextTick, ref, watch } from 'vue'
import {
  createComment,
  deleteComment,
  listComments,
  updateComment,
  type PhotoComment,
} from '../api/reactions'
import { useAuthStore } from '../stores/auth'
import { useRealtimeEvent } from '../composables/useRealtime'
import PhotoCommentThread from './PhotoCommentThread.vue'

const props = defineProps<{
  photoId: number
  // Album in whose detail view this thread is open. Comments are
  // album-scoped: listing, creating and the realtime sync all key off
  // this album so a comment written here stays in this album only.
  albumId: number
}>()

const emit = defineEmits<{
  // The local user added (+1) or removed (-1) a comment. Lets the album
  // grid update the "has comments" badge for this photo immediately — the
  // realtime fan-out excludes the actor, so this covers their own change.
  (e: 'comment-count-change', payload: { photoId: number; delta: number }): void
}>()

const auth = useAuthStore()
const currentAuthor = computed(() => {
  const id = auth.user?.id ?? null
  return id !== null ? { id, kind: 'user' as const } : null
})

const comments = ref<PhotoComment[]>([])
const loading = ref(false)
const error = ref('')
const submitting = ref(false)

async function load() {
  if (!props.photoId || props.albumId == null) return
  loading.value = true
  error.value = ''
  try {
    const c = await listComments(props.photoId, props.albumId)
    comments.value = c.comments
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Fehler beim Laden'
  } finally {
    loading.value = false
  }
}

async function onSubmit(body: string) {
  submitting.value = true
  error.value = ''
  try {
    const created = await createComment(props.photoId, body, props.albumId)
    comments.value.push(created)
    emit('comment-count-change', { photoId: props.photoId, delta: 1 })
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Kommentar fehlgeschlagen'
  } finally {
    submitting.value = false
  }
}

async function onUpdate(commentId: number, body: string) {
  try {
    const updated = await updateComment(commentId, body)
    const idx = comments.value.findIndex((x) => x.id === commentId)
    if (idx >= 0) comments.value[idx] = updated
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Speichern fehlgeschlagen'
  }
}

async function onDelete(commentId: number) {
  try {
    await deleteComment(commentId)
    comments.value = comments.value.filter((x) => x.id !== commentId)
    emit('comment-count-change', { photoId: props.photoId, delta: -1 })
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Löschen fehlgeschlagen'
  }
}

// Live updates: react to events on the `photos` channel for this photo
// *and* this album. Comments are album-scoped, so an event for the same
// photo in a different album must not touch this thread. The album id
// rides along in the event payload. useRealtimeEvent self-manages its
// mount/unmount lifecycle.
function matchesPhotoAlbum(ev: { resourceId: string | number; payload?: Record<string, unknown> }): boolean {
  if (Number(ev.resourceId) !== props.photoId) return false
  const evAlbumId = Number(ev.payload?.albumId)
  return Number.isFinite(evAlbumId) && evAlbumId === props.albumId
}

async function refreshComments() {
  try {
    const c = await listComments(props.photoId, props.albumId)
    comments.value = c.comments
  } catch {
    // Ignore — next open will re-sync.
  }
}

useRealtimeEvent('photos', 'commented', (ev) => {
  if (matchesPhotoAlbum(ev)) void refreshComments()
})
useRealtimeEvent('photos', 'comment_updated', (ev) => {
  if (matchesPhotoAlbum(ev)) void refreshComments()
})
useRealtimeEvent('photos', 'comment_deleted', (ev) => {
  if (!matchesPhotoAlbum(ev)) return
  const commentId = Number(ev.payload?.commentId)
  if (Number.isFinite(commentId)) {
    comments.value = comments.value.filter((x) => x.id !== commentId)
  }
})

watch(
  () => [props.photoId, props.albumId],
  () => {
    void nextTick(load)
  },
  { immediate: true },
)
</script>

<template>
  <PhotoCommentThread
    :comments="comments"
    :loading="loading"
    :error-message="error"
    :current-author="currentAuthor"
    :can-write="currentAuthor !== null"
    :submitting="submitting"
    @submit="onSubmit"
    @update="onUpdate"
    @delete-comment="onDelete"
  />
</template>
