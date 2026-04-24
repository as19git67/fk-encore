<script setup lang="ts">
/**
 * Guest comment thread for the public album share page. Mirrors
 * PhotoReactions.vue but talks to the cookie-authenticated guest
 * endpoints under /share/:token/...
 *
 * No realtime subscription: realtime requires bearer auth, and a
 * guest's primary update channel is the digest mail / Web Push.
 * Comments visible inside the same fullscreen view will refresh on
 * the next photo navigation (load triggers on photoId change).
 */

import { computed, nextTick, ref, watch } from 'vue'
import {
  createGuestComment,
  deleteGuestComment,
  listGuestComments,
  updateGuestComment,
} from '../api/sharedalbumComments'
import type { PhotoComment } from '../api/reactions'
import type { GuestSelf } from '../api/sharedalbum'
import PhotoCommentThread from './PhotoCommentThread.vue'

const props = defineProps<{
  shareToken: string
  photoId: number
  guest: GuestSelf | null
}>()

const emit = defineEmits<{
  (e: 'request-register'): void
  (e: 'request-verify'): void
}>()

const comments = ref<PhotoComment[]>([])
const loading = ref(false)
const error = ref('')
const submitting = ref(false)

const currentAuthor = computed(() =>
  props.guest ? { id: props.guest.id, kind: 'guest' as const } : null,
)

const canWrite = computed(() => props.guest?.verified === true)
const writeGateMessage = computed(() => {
  if (!props.guest) return 'Anmelden, um zu kommentieren'
  if (!props.guest.verified) {
    return 'E-Mail bestätigen, um zu kommentieren (Link in deinem Postfach)'
  }
  return ''
})

async function load() {
  if (!props.photoId || !props.guest) {
    comments.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const c = await listGuestComments(props.shareToken, props.photoId)
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
    const created = await createGuestComment(props.shareToken, props.photoId, body)
    comments.value.push(created)
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Kommentar fehlgeschlagen'
  } finally {
    submitting.value = false
  }
}

async function onUpdate(commentId: number, body: string) {
  try {
    const updated = await updateGuestComment(props.shareToken, commentId, body)
    const idx = comments.value.findIndex((x) => x.id === commentId)
    if (idx >= 0) comments.value[idx] = updated
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Speichern fehlgeschlagen'
  }
}

async function onDelete(commentId: number) {
  try {
    await deleteGuestComment(props.shareToken, commentId)
    comments.value = comments.value.filter((x) => x.id !== commentId)
  } catch (err: unknown) {
    error.value = (err as Error)?.message || 'Löschen fehlgeschlagen'
  }
}

function onComposerFocus() {
  // The composer only renders when canWrite is true, so this only
  // fires for verified guests — but we still surface the gate event
  // for the parent in case it wants to highlight the verify banner.
  if (!props.guest) emit('request-register')
  else if (!props.guest.verified) emit('request-verify')
}

// Re-fetch when photo changes or when guest goes from null → set
// (e.g. after a successful register). Keep an empty array while not
// signed in so the composer area shows the gate message instead of
// "noch keine Kommentare".
watch(
  () => [props.photoId, props.guest?.id],
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
    :can-write="canWrite"
    :write-gate-message="writeGateMessage"
    :submitting="submitting"
    @submit="onSubmit"
    @update="onUpdate"
    @delete-comment="onDelete"
    @composer-focus="onComposerFocus"
  />
</template>
