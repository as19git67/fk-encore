<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { getPhotoUrl } from '../api/photos'
import type { FeedAlbumItem } from '../api/photoFeed'
import { feedInitials, formatFeedTime } from '../utils/feedTime'

/**
 * A shared album in the content feed: one card for the act of sharing,
 * instead of every photo in the album as a post of its own. The whole picture
 * area opens the album.
 */
const props = defineProps<{ album: FeedAlbumItem }>()

const sharedByName = computed(() => props.album.sharedBy.name ?? 'Jemand')
const initials = computed(() => feedInitials(sharedByName.value))
const to = computed(() => ({ name: 'fotos-album-detail', params: { id: String(props.album.albumId) } }))
const countLabel = computed(() =>
  props.album.photoCount === 1 ? '1 Foto' : `${props.album.photoCount} Fotos`,
)
/** One big preview on top, up to three small ones below it. */
const lead = computed(() => props.album.previews[0] ?? null)
const rest = computed(() => props.album.previews.slice(1, 4))
</script>

<template>
  <article class="post" :data-feed-album-id="album.albumId">
    <header class="post-head">
      <div class="avatar" aria-hidden="true">{{ initials }}</div>
      <div class="head-text">
        <div class="owner">{{ sharedByName }}</div>
        <div class="sub">
          <span>hat ein Album mit dir geteilt</span>
          <span class="dot">·</span>
          <span class="time">{{ formatFeedTime(album.lastActivityAt) }}</span>
        </div>
      </div>
    </header>

    <RouterLink :to="to" class="media" :aria-label="`Album „${album.name}“ öffnen`">
      <div v-if="lead" class="lead">
        <img :src="getPhotoUrl(lead.filename, 1280)" alt="" loading="lazy" />
      </div>
      <div v-else class="lead lead--empty">
        <i class="pi pi-images" aria-hidden="true" />
      </div>
      <div v-if="rest.length > 0" class="strip" :style="{ gridTemplateColumns: `repeat(${rest.length}, 1fr)` }">
        <img
          v-for="p in rest"
          :key="p.photoId"
          :src="getPhotoUrl(p.filename, 640)"
          alt=""
          loading="lazy"
        />
      </div>
    </RouterLink>

    <div class="caption">
      <i class="pi pi-images" aria-hidden="true" />
      <div class="caption-text">
        <div class="album-name">{{ album.name }}</div>
        <div class="album-meta">{{ countLabel }}</div>
        <p v-if="album.description" class="album-desc">{{ album.description }}</p>
      </div>
    </div>
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
  font-size: var(--text-md);
  font-weight: 700;
  text-transform: uppercase;
  flex-shrink: 0;
}
.head-text { min-width: 0; }
.owner { font-weight: 600; font-size: var(--text-lg); }
.sub {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}
.dot { opacity: 0.6; }

.media {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: inherit;
  text-decoration: none;
  background: var(--p-content-hover-background);
  /* The card's `overflow: hidden` rounds its corners and the pictures fill it
     from edge to edge, so the ring is drawn inside (issue #1281). */
  outline-offset: var(--focus-ring-offset-inset);
}
.media:focus-visible { outline: var(--focus-ring); }
.lead {
  aspect-ratio: 4 / 3;
  overflow: hidden;
}
.lead--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-5xl);
  color: var(--p-text-muted-color);
}
.strip {
  display: grid;
  gap: 2px;
}
.strip img { aspect-ratio: 1; }
.media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.caption {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.6rem 0.8rem 0.8rem;
}
.caption > .pi {
  font-size: var(--text-xl);
  color: var(--p-primary-color);
  margin-top: 0.15rem;
}
.caption-text { min-width: 0; }
.album-name {
  font-weight: 600;
  font-size: var(--text-lg);
  overflow-wrap: anywhere;
}
.album-meta {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.album-desc {
  margin: 0.3rem 0 0;
  font-size: var(--text-base);
  line-height: 1.35;
}
</style>
