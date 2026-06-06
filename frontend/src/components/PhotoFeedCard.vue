<script setup lang="ts">
import { ref, computed } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import PhotoLocationMenu from './PhotoLocationMenu.vue'
import { getPhotoUrl, updatePhotoDescription } from '../api/photos'
import type { FeedPhotoItem } from '../api/photoFeed'

const props = defineProps<{
  item: FeedPhotoItem
  /** Current user id — only the photo's owner may edit its description. */
  currentUserId?: number | null
}>()
const emit = defineEmits<{
  (e: 'like', item: FeedPhotoItem): void
  (e: 'hide', item: FeedPhotoItem): void
  (e: 'comment', item: FeedPhotoItem, body: string): void
}>()

const draft = ref('')
const burst = ref(false)
const commentInput = ref<InstanceType<typeof InputText> | null>(null)

/** Focus the inline comment field — the comment icon must not navigate away. */
function focusComment() {
  const el = (commentInput.value as unknown as { $el?: HTMLElement } | null)?.$el
  el?.focus()
  el?.scrollIntoView({ block: 'nearest' })
}

// Only the photo owner may edit the description (matches the backend).
const canEdit = computed(
  () => props.currentUserId != null && props.currentUserId === props.item.owner.id,
)

// Inline description editor — mirrors the gallery/album detail view.
const editingDesc = ref(false)
const descDraft = ref('')
const savingDesc = ref(false)

function startEditDescription() {
  descDraft.value = props.item.description ?? ''
  editingDesc.value = true
}
function cancelEditDescription() {
  editingDesc.value = false
}
async function saveDescription() {
  savingDesc.value = true
  try {
    const value = descDraft.value.trim() || null
    const res = await updatePhotoDescription(props.item.photoId, value)
    // Mutating the item is intentional here (same pattern as the detail
    // sidebar) so the card reflects the new caption immediately.
    props.item.description = res.description
    editingDesc.value = false
  } catch {
    // keep the editor open so the user can retry
  } finally {
    savingDesc.value = false
  }
}

// Aspect ratio of the image box. The server only fills width/height after a
// background scan, so a freshly uploaded photo has none yet — we then fall
// back to the natural dimensions read from the <img> once it loads, so a
// portrait isn't squeezed into a landscape box and cropped. A floor keeps
// extreme verticals (e.g. long screenshots) from making an absurdly tall card.
const MIN_WIDTH_OVER_HEIGHT = 0.5 // card height at most 2× its width
const naturalRatio = ref<number | null>(null)

const aspectRatio = computed(() => {
  const w = props.item.width
  const h = props.item.height
  const ratio = w && h && w > 0 && h > 0 ? w / h : naturalRatio.value
  if (ratio == null) return '4 / 3'
  return String(Math.max(ratio, MIN_WIDTH_OVER_HEIGHT))
})

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    naturalRatio.value = img.naturalWidth / img.naturalHeight
  }
}

const ownerName = computed(() => props.item.owner.name ?? 'Jemand')

const initials = computed(() => {
  const n = ownerName.value.trim()
  if (!n) return '?'
  const parts = n.split(/\s+/)
  return (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')
})

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diffMin = Math.round((Date.now() - d.getTime()) / 60_000)
  if (diffMin < 1) return 'gerade eben'
  if (diffMin < 60) return `vor ${diffMin} min`
  const diffH = Math.round(diffMin / 60)
  if (diffH < 24) return `vor ${diffH} h`
  const diffD = Math.round(diffH / 24)
  if (diffD < 7) return `vor ${diffD} Tg.`
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

function onDoubleTap() {
  // Double-tap to like (Instagram gesture). Only adds a like, never removes —
  // matches the platform's one-way double-tap behaviour.
  if (!props.item.likedByMe) {
    burst.value = true
    window.setTimeout(() => (burst.value = false), 600)
    emit('like', props.item)
  }
}

function submitComment() {
  const body = draft.value.trim()
  if (!body) return
  emit('comment', props.item, body)
  draft.value = ''
}
</script>

<template>
  <article class="post">
    <header class="post-head">
      <div class="avatar" aria-hidden="true">{{ initials }}</div>
      <div class="head-text">
        <div class="owner">{{ ownerName }}</div>
        <div class="sub">
          <span v-if="item.album" class="album">{{ item.album.name }}</span>
          <span class="dot">·</span>
          <span class="time">{{ formatTime(item.lastActivityAt) }}</span>
        </div>
      </div>
    </header>

    <div class="media" :class="{ 'media--hidden': item.hiddenByMe }" :style="{ aspectRatio }" @dblclick="onDoubleTap">
      <img :src="getPhotoUrl(item.filename, 1280)" :alt="item.description ?? item.filename" loading="lazy" @load="onImageLoad" />
      <i v-if="burst" class="pi pi-heart-fill burst" aria-hidden="true" />
      <i v-if="item.hiddenByMe" class="pi pi-eye-slash hidden-badge" aria-hidden="true" />
    </div>

    <div class="actions">
      <button
        class="icon-btn"
        :class="{ liked: item.likedByMe }"
        :aria-pressed="item.likedByMe"
        :title="item.likedByMe ? 'Gefällt mir nicht mehr' : 'Gefällt mir'"
        @click="emit('like', item)"
      >
        <i :class="item.likedByMe ? 'pi pi-heart-fill' : 'pi pi-heart'" />
        <span v-if="item.likeCount > 0" class="count">{{ item.likeCount }}</span>
      </button>
      <button
        class="icon-btn"
        :class="{ hidden: item.hiddenByMe }"
        :aria-pressed="item.hiddenByMe"
        :title="item.hiddenByMe ? 'Ausblenden aufheben' : 'Ausblenden'"
        :aria-label="item.hiddenByMe ? 'Ausblenden aufheben' : 'Ausblenden'"
        @click="emit('hide', item)"
      >
        <i :class="item.hiddenByMe ? 'pi pi-thumbs-down-fill' : 'pi pi-thumbs-down'" />
      </button>
      <button class="icon-btn" title="Kommentieren" @click="focusComment">
        <i class="pi pi-comment" />
        <span v-if="item.commentCount > 0" class="count">{{ item.commentCount }}</span>
      </button>
      <PhotoLocationMenu
        :photo-id="item.photoId"
        select-in-grid
        :extra-query="{ from: 'stream' }"
      >
        <template #trigger="{ open, loading }">
          <button
            class="icon-btn"
            :disabled="loading"
            title="Öffnen in…"
            aria-label="Öffnen in…"
            @click="open"
          >
            <i :class="loading ? 'pi pi-spin pi-spinner' : 'pi pi-external-link'" />
          </button>
        </template>
      </PhotoLocationMenu>
      <button
        v-if="canEdit && !item.description && !editingDesc"
        class="icon-btn"
        title="Beschreibung hinzufügen"
        aria-label="Beschreibung hinzufügen"
        @click="startEditDescription"
      >
        <i class="pi pi-pencil" />
      </button>
    </div>

    <div v-if="editingDesc" class="desc-editor">
      <InputText
        v-model="descDraft"
        placeholder="Beschreibung…"
        class="desc-input"
        @keydown.escape="cancelEditDescription"
        @keyup.enter="saveDescription"
      />
      <button class="icon-btn small" :disabled="savingDesc" title="Speichern" @click="saveDescription">
        <i :class="savingDesc ? 'pi pi-spin pi-spinner' : 'pi pi-check'" />
      </button>
      <button class="icon-btn small" :disabled="savingDesc" title="Abbrechen" @click="cancelEditDescription">
        <i class="pi pi-times" />
      </button>
    </div>
    <p v-else-if="item.description" class="caption">
      <span class="owner-inline">{{ ownerName }}</span>{{ item.description }}
      <button
        v-if="canEdit"
        class="icon-btn caption-edit"
        title="Beschreibung bearbeiten"
        @click="startEditDescription"
      >
        <i class="pi pi-pencil" />
      </button>
    </p>

    <p v-if="item.latestComment" class="comment-preview">
      <span class="owner-inline">{{ item.latestComment.author ?? 'Gast' }}</span>
      {{ item.latestComment.excerpt }}
    </p>

    <form v-if="item.album" class="add-comment" @submit.prevent="submitComment">
      <InputText ref="commentInput" v-model="draft" placeholder="Kommentieren…" class="comment-input" />
      <Button
        type="submit"
        label="Senden"
        text
        size="small"
        :disabled="draft.trim().length === 0"
      />
    </form>
  </article>
</template>

<style scoped>
.post {
  display: flex;
  flex-direction: column;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 12px;
  overflow: hidden;
}

.post-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.8rem;
}
.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  flex-shrink: 0;
}
.head-text { min-width: 0; }
.owner { font-weight: 600; font-size: 0.95rem; }
.sub {
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
  display: flex;
  gap: 0.35rem;
  align-items: center;
}
.album { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60vw; }
.dot { opacity: 0.6; }

.media {
  position: relative;
  width: 100%;
  /* Height follows aspect-ratio (set inline). No fixed max-height clamp — a
     clamp shorter than the aspect ratio would make object-fit: cover crop
     portraits top/bottom. Extreme verticals are bounded in JS instead. */
  background: var(--p-content-hover-background);
  cursor: pointer;
  overflow: hidden;
}
.media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* Mirrors the gallery/album look for a viewer-hidden photo. */
.media--hidden img { opacity: 0.35; }
.hidden-badge {
  position: absolute;
  top: 0.6rem;
  right: 0.6rem;
  font-size: 1.4rem;
  color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.burst {
  position: absolute;
  inset: 0;
  margin: auto;
  width: max-content;
  height: max-content;
  font-size: 6rem;
  color: #fff;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
  animation: burst 0.6s ease-out;
  pointer-events: none;
}
@keyframes burst {
  0% { transform: scale(0.3); opacity: 0; }
  30% { transform: scale(1.1); opacity: 1; }
  60% { transform: scale(1); opacity: 1; }
  100% { transform: scale(1); opacity: 0; }
}

.actions {
  display: flex;
  gap: 0.25rem;
  padding: 0.35rem 0.5rem 0.1rem;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.35rem 0.6rem;
  font-size: 1.4rem;
  line-height: 1;
  color: var(--p-text-color);
  border-radius: 999px;
}
.icon-btn:hover { background: var(--p-content-hover-background); }
.icon-btn.liked { color: var(--p-red-500, #e0245e); }
.icon-btn.hidden { color: var(--p-primary-color); }
.icon-btn .count {
  font-size: 0.9rem;
  font-weight: 600;
  min-width: 0.6em;
}
.icon-btn.small {
  font-size: 1.05rem;
  padding: 0.3rem 0.4rem;
}
.icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.desc-editor {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.6rem;
}
.desc-input {
  flex: 1;
  min-width: 0;
}

.caption {
  margin: 0.15rem 0;
  padding: 0 0.8rem;
  font-size: 0.92rem;
  line-height: 1.35;
}
.owner-inline { font-weight: 600; margin-right: 0.3rem; }
/* Edit pencil sized to the caption text and vertically centered with it. */
.icon-btn.caption-edit {
  font-size: 0.8rem;
  padding: 0.1rem 0.3rem;
  vertical-align: middle;
}

.comment-preview {
  margin: 0.1rem 0;
  padding: 0 0.8rem;
  font-size: 0.9rem;
}
.add-comment {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem 0.7rem;
  border-top: 1px solid var(--p-content-border-color);
  margin-top: 0.4rem;
}
.comment-input { flex: 1; }
</style>
