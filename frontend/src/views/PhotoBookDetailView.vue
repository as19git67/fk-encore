<script setup lang="ts">
/**
 * One photo book (documentation/plans/fotobuch.md): the cover, then every
 * chapter with its pages as the PDF lays them out. Chapter titles are edited
 * in place, each page picks one of the layouts for its number of photos, and
 * a photo can become the cover or leave the book. "Neu verteilen" lays the
 * book out again from its source; the PDF comes from the export dialog.
 *
 * Stages 2 and 3: the model proposes captions, chapter titles and layouts
 * (`PhotoBookAiDialog`). A caption is edited from the photo's menu, captions
 * are switched on for the book in its settings and per page at its foot, and a
 * chapter whose own title the user kept shows the model's proposal to take.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Menu from 'primevue/menu'
import type { MenuItem } from 'primevue/menuitem'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import PageLayout from '../components/layout/PageLayout.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import ResponsiveToolbar, { type ToolbarItem } from '../components/ResponsiveToolbar.vue'
import PhotoBookPagePreview from '../components/photobook/PhotoBookPagePreview.vue'
import PhotoBookExportDialog from '../components/photobook/PhotoBookExportDialog.vue'
import PhotoBookAiDialog from '../components/photobook/PhotoBookAiDialog.vue'
import { useModuleBack } from '../composables/useModuleBack'
import {
  PHOTO_BOOK_FORMATS,
  acceptPhotoBookChapterSuggestion,
  deletePhotoBook,
  getPhotoBook,
  photoBookThumbUrl,
  rebuildPhotoBook,
  removePhotoFromBookPage,
  setPhotoBookCaption,
  setPhotoBookPageCaptions,
  setPhotoBookPageLayout,
  updatePhotoBook,
  updatePhotoBookChapter,
  type PhotoBook,
  type PhotoBookFormat,
  type PhotoBookPage,
  type PhotoBookSlot,
} from '../api/photoBooks'

const route = useRoute()
const router = useRouter()
const confirm = useConfirm()
const { goBack } = useModuleBack('/fotos', 'fotos-photo-books')

const book = ref<PhotoBook | null>(null)
const loading = ref(true)
const loadError = ref('')
const actionError = ref('')
const busy = ref(false)
const exportOpen = ref(false)
const aiOpen = ref(false)

const bookId = computed(() => Number(route.params.id))

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    book.value = await getPhotoBook(bookId.value)
  } catch (err: any) {
    loadError.value = err?.message ?? 'Das Fotobuch konnte nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

/** Every edit returns the whole book; one place to apply it and report a failure. */
async function apply(run: () => Promise<PhotoBook>) {
  if (busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    book.value = await run()
  } catch (err: any) {
    actionError.value = err?.message ?? 'Die Änderung ist fehlgeschlagen.'
  } finally {
    busy.value = false
  }
}

watch(bookId, () => void load())
onMounted(load)

const formatName = computed(() => PHOTO_BOOK_FORMATS.find((f) => f.id === book.value?.format)?.name ?? '')

interface ChapterBlock {
  id: number | null
  title: string
  subtitle: string | null
  /** The model's title when it differs from the one that stands. */
  suggestion: string | null
  pages: { page: PhotoBookPage; number: number }[]
}

const chapters = computed<ChapterBlock[]>(() => {
  const b = book.value
  if (!b) return []
  const blocks = new Map<number | null, ChapterBlock>()
  for (const c of b.chapters) {
    const suggestion = c.title_suggestion && c.title_suggestion !== c.title ? c.title_suggestion : null
    blocks.set(c.id, { id: c.id, title: c.title, subtitle: c.subtitle, suggestion, pages: [] })
  }
  b.pages.forEach((page, i) => {
    let block = blocks.get(page.chapter_id)
    if (!block) {
      block = { id: page.chapter_id, title: 'Ohne Kapitel', subtitle: null, suggestion: null, pages: [] }
      blocks.set(page.chapter_id, block)
    }
    block.pages.push({ page, number: i + 1 })
  })
  return [...blocks.values()].filter((c) => c.pages.length)
})

// ── chapter titles ──────────────────────────────────────────────────────

const chapterDrafts = ref<Record<number, string>>({})

watch(book, (b) => {
  chapterDrafts.value = Object.fromEntries((b?.chapters ?? []).map((c) => [c.id, c.title]))
})

function saveChapterTitle(id: number | null) {
  if (id == null || !book.value) return
  const draft = chapterDrafts.value[id]?.trim()
  const current = book.value.chapters.find((c) => c.id === id)?.title
  if (!draft || draft === current) {
    chapterDrafts.value[id] = current ?? ''
    return
  }
  void apply(() => updatePhotoBookChapter(bookId.value, id, { title: draft }))
}

function acceptSuggestion(id: number | null) {
  if (id == null) return
  void apply(() => acceptPhotoBookChapterSuggestion(bookId.value, id))
}

// ── pages and photos ────────────────────────────────────────────────────

function changeLayout(page: PhotoBookPage, layout: string) {
  if (layout === page.layout) return
  void apply(() => setPhotoBookPageLayout(bookId.value, page.id, layout))
}

/** Flip the page's captions; the page follows the book again when that is what it says. */
function toggleCaptions(page: PhotoBookPage) {
  const next = !(page.captions_override ?? book.value?.settings.captions ?? false)
  const value = next === book.value?.settings.captions ? null : next
  void apply(() => setPhotoBookPageCaptions(bookId.value, page.id, value))
}

function pageHasCaption(page: PhotoBookPage): boolean {
  return page.slots.some((s) => !!s.caption)
}

function captionsOn(page: PhotoBookPage): boolean {
  return page.captions_override ?? book.value?.settings.captions ?? false
}

const captionOpen = ref(false)
const captionTarget = ref<PhotoBookSlot | null>(null)
const captionDraft = ref('')

function openCaption(slot: PhotoBookSlot) {
  captionTarget.value = slot
  captionDraft.value = slot.caption ?? ''
  captionOpen.value = true
}

async function saveCaption() {
  const t = captionTarget.value
  if (!t) return
  await apply(() => setPhotoBookCaption(bookId.value, t.photo_id, captionDraft.value.trim() || null))
  if (!actionError.value) captionOpen.value = false
}

const slotMenu = ref<InstanceType<typeof Menu> | null>(null)
const menuTarget = ref<{ page: PhotoBookPage; slot: PhotoBookSlot } | null>(null)

const slotMenuItems = computed<MenuItem[]>(() => {
  const t = menuTarget.value
  if (!t) return []
  return [
    {
      label: t.slot.dpi ? `Druckt mit ${t.slot.dpi} dpi` : 'Auflösung unbekannt',
      icon: t.slot.low_dpi ? 'pi pi-exclamation-triangle' : 'pi pi-info-circle',
      disabled: true,
    },
    {
      label: t.slot.caption ? 'Bildunterschrift bearbeiten' : 'Bildunterschrift schreiben',
      icon: 'pi pi-align-left',
      command: (): void => openCaption(t.slot),
    },
    {
      label: 'Als Titelbild',
      icon: 'pi pi-star',
      disabled: book.value?.cover_photo_id === t.slot.photo_id,
      command: (): void => { void apply(() => updatePhotoBook(bookId.value, { coverPhotoId: t.slot.photo_id })) },
    },
    {
      label: 'Aus dem Buch nehmen',
      icon: 'pi pi-times',
      command: (): void => { void apply(() => removePhotoFromBookPage(bookId.value, t.page.id, t.slot.photo_id)) },
    },
  ]
})

function openSlotMenu(page: PhotoBookPage, slot: PhotoBookSlot, event: MouseEvent) {
  menuTarget.value = { page, slot }
  slotMenu.value?.toggle(event)
}

// ── book settings ───────────────────────────────────────────────────────

const settingsOpen = ref(false)
const draftTitle = ref('')
const draftSubtitle = ref('')
const draftFormat = ref<PhotoBookFormat>('a4-landscape')
const draftCaptions = ref(false)

function openSettings() {
  if (!book.value) return
  draftTitle.value = book.value.title
  draftSubtitle.value = book.value.subtitle ?? ''
  draftFormat.value = book.value.format
  draftCaptions.value = book.value.settings.captions
  settingsOpen.value = true
}

async function saveSettings() {
  if (!draftTitle.value.trim()) return
  await apply(() => updatePhotoBook(bookId.value, {
    title: draftTitle.value.trim(),
    subtitle: draftSubtitle.value.trim() || null,
    format: draftFormat.value,
    settings: { captions: draftCaptions.value },
  }))
  if (!actionError.value) settingsOpen.value = false
}

function confirmRebuild() {
  confirm.require({
    header: 'Neu verteilen?',
    message: 'Kapitel und Seiten werden aus der Quelle neu gebildet. Geänderte Kapiteltitel, Layouts und herausgenommene Fotos gehen dabei verloren; Bildunterschriften bleiben.',
    icon: 'pi pi-refresh',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', text: true },
    acceptProps: { label: 'Neu verteilen' },
    accept: () => void apply(() => rebuildPhotoBook(bookId.value)),
  })
}

function confirmDelete() {
  if (!book.value) return
  const title = book.value.title
  confirm.require({
    header: 'Fotobuch löschen?',
    message: `„${title}“ wird gelöscht. Die Fotos selbst bleiben erhalten.`,
    icon: 'pi pi-trash',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', text: true },
    acceptProps: { label: 'Löschen', severity: 'danger' },
    accept: async () => {
      try {
        await deletePhotoBook(bookId.value)
        void router.push({ name: 'fotos-photo-books' })
      } catch (err: any) {
        actionError.value = err?.message ?? 'Löschen fehlgeschlagen.'
      }
    },
  })
}

const toolbarItems = computed<ToolbarItem[]>(() => [
  { key: 'pdf', label: 'PDF', title: 'Als PDF ausgeben', icon: 'pi pi-file-pdf', disabled: !book.value, command: () => (exportOpen.value = true) },
  { key: 'ai', label: 'KI', title: 'Vorschläge der KI', icon: 'pi pi-sparkles', disabled: !book.value, command: () => (aiOpen.value = true) },
  { key: 'settings', label: 'Buch', title: 'Titel, Format und Bildunterschriften', icon: 'pi pi-pencil', disabled: !book.value || busy.value, command: openSettings },
  { key: 'rebuild', title: 'Neu verteilen', icon: 'pi pi-refresh', disabled: !book.value || busy.value, menuOnly: true, command: confirmRebuild },
  { key: 'delete', title: 'Fotobuch löschen', icon: 'pi pi-trash', severity: 'danger', disabled: !book.value, menuOnly: true, command: confirmDelete },
])
</script>

<template>
  <PageLayout :title="book?.title ?? 'Fotobuch'" width="wide" sticky-header :ready="!loading">
    <template #back>
      <Button icon="pi pi-arrow-left" text rounded aria-label="Zurück" @click="goBack" />
    </template>
    <template #actions>
      <ResponsiveToolbar :items="toolbarItems" />
    </template>
    <template #notice>
      <ErrorBanner v-if="loadError" :message="loadError" @retry="load" />
      <ErrorBanner v-if="actionError" :message="actionError" :retryable="false" closable @close="actionError = ''" />
    </template>

    <PageSkeleton v-if="loading && !book" variant="grid" :count="6" />
    <template v-else-if="book">
      <p class="pbd-summary">
        {{ formatName }} · {{ book.page_count }} Seiten · {{ book.photo_count }} Fotos
        <template v-if="book.subtitle"> · {{ book.subtitle }}</template>
      </p>
      <Message v-if="book.low_dpi_count" severity="warn" :closable="false" class="pbd-warn">
        {{ book.low_dpi_count === 1 ? 'Ein Foto ist' : `${book.low_dpi_count} Fotos sind` }} für seinen Platz zu klein und würde unter 200 dpi gedruckt (markiert mit <i class="pi pi-exclamation-triangle" aria-label="Warnsymbol" />).
      </Message>

      <section class="pbd-section" aria-labelledby="pbd-cover">
        <h2 id="pbd-cover" class="pbd-heading">Titelseite</h2>
        <div class="pbd-cover" :style="{ aspectRatio: `${book.width_mm} / ${book.height_mm}` }">
          <img
            v-if="book.cover_filename"
            :src="photoBookThumbUrl(book.cover_filename, 800)"
            alt=""
            :style="{ objectPosition: book.cover_auto_crop ? `${book.cover_auto_crop.x * 100}% ${book.cover_auto_crop.y * 100}%` : '50% 50%' }"
          />
          <div class="pbd-cover-band">
            <span class="pbd-cover-title">{{ book.title }}</span>
            <span v-if="book.subtitle" class="pbd-cover-sub">{{ book.subtitle }}</span>
          </div>
        </div>
        <p class="pbd-hint">Ein Foto wird zum Titelbild über sein Menü: auf das Foto tippen.</p>
      </section>

      <section v-for="ch in chapters" :key="ch.id ?? 'none'" class="pbd-section">
        <div class="pbd-chapter-head">
          <InputText
            v-if="ch.id != null"
            v-model="chapterDrafts[ch.id]"
            class="pbd-chapter-title"
            aria-label="Kapitelüberschrift"
            @keyup.enter="($event.target as HTMLInputElement).blur()"
            @blur="saveChapterTitle(ch.id)"
          />
          <h2 v-else class="pbd-heading">{{ ch.title }}</h2>
          <span v-if="ch.subtitle" class="pbd-chapter-sub">{{ ch.subtitle }}</span>
        </div>
        <p v-if="ch.suggestion" class="pbd-suggestion">
          <i class="pi pi-sparkles" aria-hidden="true" />
          <span>Vorschlag der KI: „{{ ch.suggestion }}“</span>
          <Button label="Übernehmen" size="small" text :disabled="busy" @click="acceptSuggestion(ch.id)" />
        </p>
        <ul class="pbd-pages">
          <li v-for="{ page, number } in ch.pages" :key="page.id" class="pbd-page">
            <PhotoBookPagePreview
              :page="page"
              :width-mm="book.width_mm"
              :height-mm="book.height_mm"
              :chapter-title="page.kind === 'opener' ? ch.title : null"
              :chapter-subtitle="page.kind === 'opener' ? ch.subtitle : null"
              @slot-click="(slot, ev) => openSlotMenu(page, slot, ev)"
            />
            <div class="pbd-page-foot">
              <span class="pbd-page-no">Seite {{ number }}</span>
              <Select
                v-if="page.layout_options.length > 1"
                :model-value="page.layout"
                :options="page.layout_options"
                option-label="name"
                option-value="id"
                size="small"
                :disabled="busy"
                :aria-label="`Layout von Seite ${number}`"
                @update:model-value="changeLayout(page, $event)"
              />
              <span v-else class="pbd-page-layout">{{ page.layout_options[0]?.name }}</span>
              <i
                v-if="page.layout_source === 'llm'"
                v-tooltip.top="page.layout_reason ?? 'Von der KI gewählt'"
                class="pi pi-sparkles pbd-page-ai"
                tabindex="0"
                :aria-label="`Layout von der KI gewählt${page.layout_reason ? `: ${page.layout_reason}` : ''}`"
              />
              <Button
                v-if="pageHasCaption(page)"
                icon="pi pi-align-left"
                size="small"
                text
                rounded
                :severity="captionsOn(page) ? 'primary' : 'secondary'"
                :aria-pressed="captionsOn(page)"
                :aria-label="captionsOn(page) ? `Bildunterschriften auf Seite ${number} ausblenden` : `Bildunterschriften auf Seite ${number} zeigen`"
                :disabled="busy"
                @click="toggleCaptions(page)"
              />
            </div>
          </li>
        </ul>
      </section>
    </template>

    <Menu ref="slotMenu" :model="slotMenuItems" popup />

    <PhotoBookExportDialog v-if="book" v-model:visible="exportOpen" :book="book" @saved="book = $event" />
    <PhotoBookAiDialog v-if="book" v-model:visible="aiOpen" :book-id="book.id" @changed="load" />

    <Dialog v-model:visible="captionOpen" class="dialog-sm" modal header="Bildunterschrift">
      <label class="pbd-field">
        <span>Text unter dem Foto</span>
        <Textarea v-model="captionDraft" rows="3" auto-resize maxlength="300" autofocus />
      </label>
      <p class="pbd-hint">Leer lassen entfernt die Bildunterschrift. Was du schreibst, ändert die KI nicht mehr.</p>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="captionOpen = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="busy" @click="saveCaption" />
      </template>
    </Dialog>

    <Dialog v-model:visible="settingsOpen" class="dialog-sm" modal header="Titel und Format">
      <div class="pbd-form">
        <label class="pbd-field">
          <span>Titel</span>
          <InputText v-model="draftTitle" autofocus />
        </label>
        <label class="pbd-field">
          <span>Untertitel</span>
          <InputText v-model="draftSubtitle" />
        </label>
        <label class="pbd-field">
          <span>Format</span>
          <Select v-model="draftFormat" :options="PHOTO_BOOK_FORMATS" option-label="name" option-value="id" />
        </label>
        <div class="pbd-check">
          <Checkbox v-model="draftCaptions" binary input-id="pbd-captions" />
          <label for="pbd-captions">Bildunterschriften unter den Fotos zeigen</label>
        </div>
      </div>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="settingsOpen = false" />
        <Button label="Speichern" icon="pi pi-check" :disabled="!draftTitle.trim()" :loading="busy" @click="saveSettings" />
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.pbd-summary {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
}
.pbd-warn {
  margin-bottom: var(--space-4);
}
.pbd-section {
  margin-bottom: var(--space-6);
}
.pbd-heading {
  margin: 0 0 var(--space-3);
  font-size: var(--text-xl);
}
.pbd-hint {
  margin: var(--space-2) 0 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.pbd-cover {
  position: relative;
  width: min(100%, 420px);
  overflow: hidden;
  background: rgba(0, 0, 0, 0.08);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}
.pbd-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.pbd-cover-band {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 8%;
  height: 22%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  background: rgba(0, 0, 0, 0.55);
  color: #ffffff; /* audit-ok: white on the dark band, as in the PDF */
}
.pbd-cover-title {
  font-weight: 700;
  font-size: var(--text-lg);
}
.pbd-cover-sub {
  font-size: var(--text-sm);
}
.pbd-chapter-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2) var(--space-3);
  margin-bottom: var(--space-3);
}
.pbd-chapter-title {
  flex: 1 1 260px;
  max-width: 480px;
  font-weight: 600;
}
.pbd-chapter-sub {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.pbd-pages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--space-5) var(--space-4);
}
.pbd-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pbd-page-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
}
.pbd-page-no,
.pbd-page-layout {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.pbd-suggestion {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: calc(-1 * var(--space-2)) 0 var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.pbd-page-ai {
  color: var(--p-primary-color);
  border-radius: 4px;
}
.pbd-page-ai:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.pbd-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.pbd-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.pbd-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
</style>
