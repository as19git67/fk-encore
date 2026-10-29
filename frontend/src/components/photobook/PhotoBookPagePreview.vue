<script setup lang="ts">
/**
 * One page of a photo book as the PDF lays it out: the server sends every
 * cell and caption as a share of the page, so this only places them. A cell
 * is a button; what it does is the parent's (`slot-click`).
 */
import { computed } from 'vue'
import { photoBookThumbUrl, type PageRect, type PhotoBookPage, type PhotoBookSlot } from '../../api/photoBooks'

const props = defineProps<{
  page: PhotoBookPage
  widthMm: number
  heightMm: number
  chapterTitle?: string | null
  chapterSubtitle?: string | null
}>()

const emit = defineEmits<{ (e: 'slot-click', slot: PhotoBookSlot, event: MouseEvent): void }>()

const aspect = computed(() => `${props.widthMm} / ${props.heightMm}`)

function box(r: PageRect) {
  return {
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`,
  }
}

function focal(s: PhotoBookSlot): string {
  const f = s.auto_crop
  return f ? `${f.x * 100}% ${f.y * 100}%` : '50% 50%'
}

// The caption as the PDF sets it (`fitCaptionSize` in photo-book-layout.ts):
// at most 8 pt, shrinking to 5 pt before the text would be cut, lines 1.2
// times the size apart. The PDF measures the font; here an average glyph
// width stands in for that. Sizes are shares of the page width, so the
// preview keeps the proportions at any width.
const PT_PER_MM = 72 / 25.4
const CAPTION_MAX_PT = 8
const CAPTION_MIN_PT = 5
const CAPTION_LINE_HEIGHT = 1.2
const AVERAGE_GLYPH_EM = 0.52

function captionStyle(s: PhotoBookSlot) {
  const r = s.caption_rect!
  const pad = s.caption_overlay ? 2 * 2 * PT_PER_MM : 0
  const w = r.w * props.widthMm * PT_PER_MM - pad
  const h = r.h * props.heightMm * PT_PER_MM - (s.caption_overlay ? 2 * PT_PER_MM : 0)
  const len = (s.caption ?? '').length
  const linesAt = (size: number) => Math.max(1, Math.ceil((len * AVERAGE_GLYPH_EM * size) / Math.max(1, w)))
  let size = CAPTION_MAX_PT
  while (size > CAPTION_MIN_PT && linesAt(size) * CAPTION_LINE_HEIGHT * size > h) size -= 0.25
  const lines = Math.max(1, Math.floor(h / (CAPTION_LINE_HEIGHT * size)))
  return {
    ...box(r),
    fontSize: `${(size / (props.widthMm * PT_PER_MM)) * 100}cqw`,
    '--pbp-caption-lines': String(lines),
  }
}

function slotLabel(s: PhotoBookSlot): string {
  const base = `Foto ${s.slot + 1} der Seite`
  return s.low_dpi ? `${base}, nur ${s.dpi} dpi` : base
}
</script>

<template>
  <div class="pbp-page" :style="{ aspectRatio: aspect }">
    <div
      v-if="page.text_rect && chapterTitle"
      class="pbp-text"
      :class="{ 'pbp-text--center': !page.slots.length }"
      :style="box(page.text_rect)"
    >
      <span class="pbp-title">{{ chapterTitle }}</span>
      <span v-if="chapterSubtitle" class="pbp-sub">{{ chapterSubtitle }}</span>
    </div>
    <button
      v-for="s in page.slots"
      :key="s.slot"
      type="button"
      class="pbp-slot"
      :style="box(s.rect)"
      :aria-label="slotLabel(s)"
      @click="emit('slot-click', s, $event)"
    >
      <img :src="photoBookThumbUrl(s.filename)" alt="" loading="lazy" :style="{ objectPosition: focal(s) }" />
      <span v-if="s.low_dpi" class="pbp-warn" aria-hidden="true"><i class="pi pi-exclamation-triangle" /></span>
    </button>
    <template v-for="s in page.slots" :key="`c${s.slot}`">
      <span
        v-if="s.caption_rect && s.caption"
        class="pbp-caption"
        :class="{ 'pbp-caption--overlay': s.caption_overlay }"
        :style="captionStyle(s)"
      ><span class="pbp-caption-text">{{ s.caption }}</span></span>
    </template>
  </div>
</template>

<style scoped>
.pbp-page {
  position: relative;
  width: 100%;
  background: #ffffff; /* audit-ok: printed paper is white in both themes */
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  font-size: var(--text-sm);
  /* Caption sizes are shares of the page width, as on paper. */
  container-type: inline-size;
}
.pbp-text {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
  color: #222222; /* audit-ok: ink on the white paper above */
}
.pbp-text--center {
  justify-content: center;
  align-items: center;
  text-align: center;
}
.pbp-title {
  font-weight: 700;
  font-size: var(--text-sm);
  line-height: 1.2;
}
.pbp-sub {
  font-size: var(--text-xs);
  color: #666666; /* audit-ok: muted ink on the white paper */
}
.pbp-slot {
  position: absolute;
  padding: 0;
  border: 0;
  background: rgba(0, 0, 0, 0.08);
  cursor: pointer;
  overflow: hidden;
}
/* The page clips, and a full-bleed cell fills it: the ring goes inside. */
.pbp-slot:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset-inset);
}
.pbp-slot img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* The strip is as high as its lines; descenders of the last one hang below
   it, so the strip does not clip and the text clips only below them. */
.pbp-caption {
  position: absolute;
  line-height: 1.2;
  color: #666666; /* audit-ok: muted ink on the white paper */
  pointer-events: none;
}
.pbp-caption-text {
  display: -webkit-box;
  -webkit-line-clamp: var(--pbp-caption-lines, 2);
  line-clamp: var(--pbp-caption-lines, 2);
  -webkit-box-orient: vertical;
  overflow: hidden;
  padding-bottom: 0.25em;
}
.pbp-caption--overlay {
  display: flex;
  align-items: flex-end;
}
.pbp-caption--overlay .pbp-caption-text {
  padding: 0.1em 0.5em 0.25em;
  background: rgba(0, 0, 0, 0.5);
  color: #ffffff; /* audit-ok: white on the dark band, as in the PDF */
}
.pbp-warn {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  padding: 2px 4px;
  border-radius: 4px;
  background: var(--p-tag-warn-background);
  color: var(--p-tag-warn-color);
  font-size: var(--text-xs);
}
</style>
