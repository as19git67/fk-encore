<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Button from 'primevue/button'
import Popover from 'primevue/popover'
import { useConfirm } from 'primevue/useconfirm'
import type { PhotoComment } from '../api/reactions'

/**
 * Presentational comment thread.
 *
 * Owns the composer, the inline-edit flow and the action popover, but
 * never talks to the network: comments come in via props, mutations
 * leave via events. This lets the user-app and the public share-page
 * reuse the exact same UI while binding to different APIs (bearer-
 * authenticated vs cookie-authenticated guest endpoints).
 *
 * Identity comparison is parameterised through `currentAuthor` so a
 * user id and a guest id (which share a number space but are distinct
 * principals) never collide.
 */

interface CurrentAuthor {
  id: number
  kind: 'user' | 'guest'
}

const props = defineProps<{
  comments: PhotoComment[]
  loading?: boolean
  errorMessage?: string
  currentAuthor: CurrentAuthor | null
  canWrite: boolean
  /**
   * Shown in place of the composer when canWrite is false (e.g. guest
   * who hasn't verified their e-mail yet, or anonymous visitor).
   */
  writeGateMessage?: string
  submitting?: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', body: string): void
  (e: 'update', commentId: number, body: string): void
  (e: 'delete-comment', commentId: number): void
  (e: 'composer-focus'): void
}>()

const confirm = useConfirm()

const commentInput = ref('')
const editingId = ref<number | null>(null)
const editingText = ref('')

const composerTextarea = ref<HTMLTextAreaElement | null>(null)
const editTextarea = ref<HTMLTextAreaElement | null>(null)

function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

watch(commentInput, () => nextTick(() => autoGrow(composerTextarea.value)))
watch([editingId, editingText], () => nextTick(() => autoGrow(editTextarea.value)))

const actionPopover = ref<InstanceType<typeof Popover> | null>(null)
const actionTarget = ref<PhotoComment | null>(null)
const actionTriggerEl = ref<HTMLElement | null>(null)

// PrimeVue's built-in outside-click dismissal listens on `document` in
// the bubble phase. Several ancestors in the fullscreen flyout use
// `@click.stop`, so those events never reach the document and the
// popover stays open. We intercept clicks ourselves in the capture
// phase, which runs before any ancestor can stop propagation.
function handleOutsidePointerDown(event: PointerEvent) {
  const target = event.target as Node | null
  if (!target) return
  const trigger = actionTriggerEl.value
  if (trigger && trigger.contains(target)) return
  const popoverRoot = document.querySelector('.reactions__menu')?.closest('.p-popover')
  if (popoverRoot && popoverRoot.contains(target)) return
  closeActions()
}

function openActions(event: Event, c: PhotoComment) {
  if (editingId.value === c.id) return
  actionTarget.value = c
  actionTriggerEl.value = event.currentTarget as HTMLElement
  actionPopover.value?.show(event)
  document.addEventListener('pointerdown', handleOutsidePointerDown, true)
}

function closeActions() {
  document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
  actionPopover.value?.hide()
  actionTarget.value = null
  actionTriggerEl.value = null
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
})

function handleEditFromMenu() {
  const c = actionTarget.value
  closeActions()
  if (c) startEdit(c)
}

function handleDeleteFromMenu() {
  const c = actionTarget.value
  closeActions()
  if (c) requestDelete(c)
}

// When there are more than VISIBLE_COMMENT_COUNT comments we collapse
// to the newest few by default. The user can expand via a toggle
// rendered inside the composer (where their focus already is).
const VISIBLE_COMMENT_COUNT = 3
const expanded = ref(false)
const hiddenCount = computed(() =>
  Math.max(0, props.comments.length - VISIBLE_COMMENT_COUNT),
)
const visibleComments = computed(() =>
  expanded.value || hiddenCount.value === 0
    ? props.comments
    : props.comments.slice(-VISIBLE_COMMENT_COUNT),
)

function submitComment() {
  const body = commentInput.value.trim()
  if (!body || props.submitting) return
  emit('submit', body)
  commentInput.value = ''
}

function startEdit(c: PhotoComment) {
  editingId.value = c.id
  editingText.value = c.body
}

function cancelEdit() {
  editingId.value = null
  editingText.value = ''
}

function saveEdit(c: PhotoComment) {
  const body = editingText.value.trim()
  if (!body) return
  emit('update', c.id, body)
  cancelEdit()
}

function requestDelete(c: PhotoComment) {
  confirm.require({
    message: 'Kommentar wirklich löschen?',
    header: 'Kommentar löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Löschen', severity: 'danger' },
    accept: () => emit('delete-comment', c.id),
  })
}

const lastCommentId = computed<number | null>(() => {
  if (props.comments.length === 0) return null
  return props.comments[props.comments.length - 1]?.id ?? null
})

function isOwn(c: PhotoComment): boolean {
  const me = props.currentAuthor
  if (!me) return false
  // Author kind defaults to "user" for backwards-compatible payloads
  // that predate the guest feature — at the time those existed, only
  // users could comment, so the comparison is safe.
  const authorKind = c.author.kind ?? 'user'
  return authorKind === me.kind && c.author.id === me.id
}

// Edit is only offered when the user's comment is the latest in the
// thread. Once anyone else has replied the conversation has moved on
// and prior entries stay frozen. Delete remains available on every
// own comment.
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
</script>

<template>
  <div class="reactions">
    <div v-if="errorMessage" class="reactions__error">{{ errorMessage }}</div>

    <div class="reactions__comments">
      <div
        v-for="c in visibleComments"
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
              ref="editTextarea"
              v-model="editingText"
              class="p-inputtext reactions__edit-textarea"
              rows="1"
              @input="autoGrow(($event.target as HTMLTextAreaElement))"
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

    <form v-if="canWrite" class="reactions__composer" @submit.prevent="submitComment">
      <button
        v-if="hiddenCount > 0 || expanded"
        type="button"
        class="reactions__toggle"
        :title="expanded ? 'Einklappen' : `${hiddenCount} ältere anzeigen`"
        @click="expanded = !expanded"
      >
        <i :class="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-up'" />
        <span v-if="!expanded">{{ hiddenCount }}</span>
      </button>
      <textarea
        ref="composerTextarea"
        v-model="commentInput"
        class="p-inputtext reactions__composer-textarea"
        rows="1"
        placeholder="Kommentar schreiben…"
        :disabled="submitting"
        @focus="emit('composer-focus')"
        @input="autoGrow(($event.target as HTMLTextAreaElement))"
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
    <div v-else-if="writeGateMessage" class="reactions__gate">
      {{ writeGateMessage }}
    </div>
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
  background: color-mix(in srgb, var(--p-text-color) 12%, transparent);
  color: var(--p-text-color);
  border-bottom-left-radius: 4px;
}
.is-own .reactions__bubble {
  background: color-mix(in srgb, var(--p-primary-color) 22%, transparent);
  color: var(--p-text-color);
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
  align-items: center;
}

.reactions__composer-textarea {
  flex: 1;
  min-width: 0;
  resize: none;
  overflow-y: auto;
  max-height: 8em;
  padding: 0.45rem 0.7rem;
  line-height: 1.3;
}

.reactions__toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--p-surface-border-color, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--p-text-color) 8%, transparent);
  color: var(--p-text-color);
  font: inherit;
  font-size: 0.8em;
  cursor: pointer;
  flex-shrink: 0;
}
.reactions__toggle:hover,
.reactions__toggle:focus-visible {
  background: color-mix(in srgb, var(--p-text-color) 16%, transparent);
  outline: none;
}

.reactions__edit-textarea {
  width: 100%;
  font-size: 0.85em;
  resize: none;
  overflow-y: auto;
  max-height: 8em;
}

.reactions__gate {
  font-size: 0.85em;
  color: var(--p-text-muted-color);
  padding: 0.5rem 0.6rem;
  border-radius: 8px;
  background: color-mix(in srgb, var(--p-text-color) 6%, transparent);
  text-align: center;
}
</style>
