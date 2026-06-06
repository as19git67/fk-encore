<script setup lang="ts">
import { ref, computed } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import { getPhotoUrl } from '../api/photos'
import type { FeedPhotoItem } from '../api/photoFeed'

const props = defineProps<{ item: FeedPhotoItem }>()
const emit = defineEmits<{
  (e: 'like', item: FeedPhotoItem): void
  (e: 'hide', item: FeedPhotoItem): void
  (e: 'open', item: FeedPhotoItem): void
  (e: 'comment', item: FeedPhotoItem, body: string): void
}>()

const draft = ref('')
const burst = ref(false)

// Reserve the image box at the photo's aspect ratio so the stream doesn't
// reflow as images load. Falls back to a 4:3 box when dimensions are unknown.
const aspectRatio = computed(() => {
  const w = props.item.width
  const h = props.item.height
  if (w && h && w > 0 && h > 0) return `${w} / ${h}`
  return '4 / 3'
})

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

    <div class="media" :class="{ 'media--hidden': item.hiddenByMe }" :style="{ aspectRatio }" @dblclick="onDoubleTap" @click="emit('open', item)">
      <img :src="getPhotoUrl(item.filename, 1280)" :alt="item.description ?? item.filename" loading="lazy" />
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
      <button class="icon-btn" title="Kommentare" @click="emit('open', item)">
        <i class="pi pi-comment" />
        <span v-if="item.commentCount > 0" class="count">{{ item.commentCount }}</span>
      </button>
    </div>

    <p v-if="item.description" class="caption">
      <span class="owner-inline">{{ ownerName }}</span> {{ item.description }}
    </p>

    <p v-if="item.latestComment" class="comment-preview">
      <span class="owner-inline">{{ item.latestComment.author ?? 'Gast' }}</span>
      {{ item.latestComment.excerpt }}
    </p>

    <form v-if="item.album" class="add-comment" @submit.prevent="submitComment">
      <InputText v-model="draft" placeholder="Kommentieren…" class="comment-input" />
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
  max-height: 80vh;
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

.caption {
  margin: 0.15rem 0;
  padding: 0 0.8rem;
  font-size: 0.92rem;
  line-height: 1.35;
}
.owner-inline { font-weight: 600; margin-right: 0.3rem; }

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
