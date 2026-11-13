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
 *
 * Stage 6: "Diashow" plays the book in the recap player, page by page with
 * its chapter titles and captions (`utils/photoBookSlideshow.ts`), to the
 * recaps' music; another track is one tap away.
 *
 * Edited photos: the book shows and prints each photo as its owner edited it
 * (crop, rotation). The layout follows only on request: when an edit leaves
 * pages that would fit better laid out again, a notice offers "Seiten
 * anpassen"; a page with a layout the user chose keeps it and only says so.
 *
 * Photos that would print under 200 dpi: the warning jumps from one such page
 * to the next ("Zeigen") and fixes what a layout can ("Beheben": another
 * layout or order, else a page of its own). What is too small even alone
 * stays marked; its menu offers a larger photo of the same scene in its
 * place (its series, or alike and taken within a few hours) or to take it out.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { saveModuleListAnchor } from '../utils/listAnchor'
import { useShareLink } from '../composables/useShareLink'
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
import PhotoBookNarrowingDialog from '../components/photobook/PhotoBookNarrowingDialog.vue'
import RecapPlayer from '../components/RecapPlayer.vue'
import { getRecapMusicUrl, listRecapMusic, type MusicTrack } from '../api/recaps'
import { photoBookSlideshow } from '../utils/photoBookSlideshow'
import { useModuleBack } from '../composables/useModuleBack'
import { useAuthStore } from '../stores/auth'
import {
  PHOTO_BOOK_FORMATS,
  acceptPhotoBookChapterSuggestion,
  deletePhotoBook,
  fitPhotoBookToEdits,
  fixPhotoBookLowDpi,
  movePhotoToOwnPage,
  replacePhotoInBook,
  suggestPhotoBookReplacements,
  getPhotoBook,
  photoBookImageUrl,
  rebuildPhotoBook,
  removePhotoFromBookPage,
  setPhotoBookCaption,
  setPhotoBookPageCaptions,
  setPhotoBookPageLayout,
  updatePhotoBook,
  updatePhotoBookChapter,
  type PhotoBook,
  type PhotoBookFormat,
  type PhotoBookLowDpiFix,
  type PhotoBookReplacement,
  type PhotoBookPage,
  type PhotoBookSlot,
} from '../api/photoBooks'

const route = useRoute()
const router = useRouter()
const confirm = useConfirm()
const { goBack } = useModuleBack('/fotos', 'fotos-photo-books')
const auth = useAuthStore()

const book = ref<PhotoBook | null>(null)
const loading = ref(true)
const loadError = ref('')
const actionError = ref('')
const busy = ref(false)
const exportOpen = ref(false)
const aiOpen = ref(false)
const narrowingOpen = ref(false)
const showOpen = ref(false)
const showTracks = ref<MusicTrack[]>([])
const showTrack = ref(0)

const slideshow = computed(() => (book.value ? photoBookSlideshow(book.value) : []))
const slideshowPhotos = computed(() => slideshow.value.flatMap((s) => s.photos))
const showMusicUrl = computed(() => {
  const track = showTracks.value[showTrack.value]
  return track ? getRecapMusicUrl(track) : null
})

/** The recaps' tracks, a warm one first; a silent show when there are none. */
async function openSlideshow() {
  if (!slideshow.value.length) return
  showOpen.value = true
  if (showTracks.value.length) return
  try {
    const { tracks } = await listRecapMusic()
    const warm = tracks.findIndex((t) => t.mood === 'warm')
    showTracks.value = warm > 0 ? [tracks[warm]!, ...tracks.filter((_, i) => i !== warm)] : tracks
    showTrack.value = 0
  } catch {
    showTracks.value = []
  }
}

function nextTrack() {
  if (showTracks.value.length > 1) showTrack.value = (showTrack.value + 1) % showTracks.value.length
}

const bookId = computed(() => Number(route.params.id))
const { shareLinkItem } = useShareLink()

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    book.value = await getPhotoBook(bookId.value)
    // A shared link lands here without a list click; going back still has to
    // mark this book in the list.
    saveModuleListAnchor('photoBook', bookId.value)
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

const coverUrl = computed(() => {
  const b = book.value
  if (!b?.cover_filename) return null
  return photoBookImageUrl({ photoId: b.cover_photo_id, filename: b.cover_filename, editedAt: b.cover_edited_at }, auth.user?.id, 800)
})

const coverFocal = computed(() => {
  const f = book.value?.cover_focal ?? book.value?.cover_auto_crop
  return f ? `${f.x * 100}% ${f.y * 100}%` : '50% 50%'
})

function fitToEdits() {
  void apply(() => fitPhotoBookToEdits(bookId.value))
}

// ── photos under 200 dpi ────────────────────────────────────────────────

const lowDpiPages = computed(() => (book.value?.pages ?? []).filter((p) => p.slots.some((s) => s.low_dpi)))
const lowDpiCursor = ref(-1)
const flashPage = ref<number | null>(null)
const lowDpiFix = ref<PhotoBookLowDpiFix | null>(null)

/** Scroll to the next page with a photo under 200 dpi, round and round. */
function showNextLowDpi() {
  const list = lowDpiPages.value
  if (!list.length) return
  lowDpiCursor.value = (lowDpiCursor.value + 1) % list.length
  const page = list[lowDpiCursor.value]!
  const el = document.getElementById(`pbd-page-${page.id}`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el?.focus({ preventScroll: true })
  flashPage.value = page.id
  window.setTimeout(() => { if (flashPage.value === page.id) flashPage.value = null }, 1600)
}

function pageNumberOf(pageId: number): number {
  return (book.value?.pages.findIndex((p) => p.id === pageId) ?? -1) + 1
}

const lowDpiPagesText = computed(() => {
  const numbers = lowDpiPages.value.map((p) => pageNumberOf(p.id))
  if (!numbers.length) return ''
  return numbers.length === 1 ? `Seite ${numbers[0]}` : `Seiten ${numbers.slice(0, -1).join(', ')} und ${numbers[numbers.length - 1]}`
})

function fixLowDpi() {
  lowDpiFix.value = null
  lowDpiCursor.value = -1
  void apply(async () => {
    const { book: next, fix } = await fixPhotoBookLowDpi(bookId.value)
    lowDpiFix.value = fix
    return next
  })
}

const lowDpiFixText = computed(() => {
  const f = lowDpiFix.value
  if (!f) return ''
  const parts: string[] = []
  if (f.rearranged) parts.push(f.rearranged === 1 ? 'eine Seite neu angeordnet' : `${f.rearranged} Seiten neu angeordnet`)
  if (f.own_pages) parts.push(f.own_pages === 1 ? 'ein Foto auf eine eigene Seite gesetzt' : `${f.own_pages} Fotos auf eine eigene Seite gesetzt`)
  const joined = parts.join(' und ')
  const done = joined ? `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.` : 'Am Layout ließ sich nichts verbessern.'
  if (!f.remaining) return `${done} Alle Fotos drucken jetzt mit mindestens 200 dpi.`
  return `${done} ${f.remaining === 1 ? 'Ein Foto ist' : `${f.remaining} Fotos sind`} selbst allein auf einer Seite zu klein. Im Menü des Fotos findest du größere Fotos derselben Szene zum Ersetzen, oder du nimmst ${f.remaining === 1 ? 'es' : 'sie'} aus dem Buch.`
})

// A larger photo of the same scene in a small one's place.
const replaceOpen = ref(false)
const replaceTarget = ref<{ page: PhotoBookPage; slot: PhotoBookSlot } | null>(null)
const replacements = ref<PhotoBookReplacement[]>([])
const replaceLoading = ref(false)
const replaceError = ref('')

async function openReplace(page: PhotoBookPage, slot: PhotoBookSlot) {
  replaceTarget.value = { page, slot }
  replacements.value = []
  replaceError.value = ''
  replaceLoading.value = true
  replaceOpen.value = true
  try {
    replacements.value = (await suggestPhotoBookReplacements(bookId.value, page.id, slot.photo_id)).replacements
  } catch (err: any) {
    replaceError.value = err?.message ?? 'Die Vorschläge konnten nicht geladen werden.'
  } finally {
    replaceLoading.value = false
  }
}

async function chooseReplacement(r: PhotoBookReplacement) {
  const t = replaceTarget.value
  if (!t) return
  await apply(() => replacePhotoInBook(bookId.value, t.page.id, t.slot.photo_id, r.photo_id))
  if (!actionError.value) replaceOpen.value = false
}

function replacementUrl(r: PhotoBookReplacement): string {
  return photoBookImageUrl({ photoId: r.photo_id, filename: r.filename, editedAt: r.edited_at }, auth.user?.id, 320)
}

function replacementLabel(r: PhotoBookReplacement): string {
  const when = r.taken_at ? new Date(r.taken_at.replace(' ', 'T')).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'ohne Datum'
  return `Dieses Foto einsetzen: ${when}, druckt mit ${r.dpi} dpi${r.same_series ? ', aus derselben Serie' : ''}`
}

function misfitHint(page: PhotoBookPage): string {
  return page.edit_misfit === 'own_layout'
    ? 'Ein bearbeitetes Foto passt nicht mehr gut in das Layout, das du gewählt hast. Ein anderes Layout schneidet weniger ab.'
    : 'Ein bearbeitetes Foto passt nicht mehr gut auf diese Seite. „Seiten anpassen“ ordnet sie neu.'
}

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
    ...(t.slot.low_dpi
      ? [{
          label: 'Durch größeres Foto ersetzen …',
          icon: 'pi pi-images',
          command: (): void => { void openReplace(t.page, t.slot) },
        }]
      : []),
    ...(t.slot.low_dpi && t.page.kind === 'photos' && t.page.slots.length > 1
      ? [{
          label: 'Auf eigene Seite',
          icon: 'pi pi-window-maximize',
          command: (): void => { void apply(() => movePhotoToOwnPage(bookId.value, t.page.id, t.slot.photo_id)) },
        }]
      : []),
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
  { key: 'show', label: 'Diashow', title: 'Als Diashow abspielen', icon: 'pi pi-play', disabled: !slideshow.value.length, command: openSlideshow },
  { key: 'ai', label: 'KI', title: 'Vorschläge der KI', icon: 'pi pi-sparkles', disabled: !book.value, command: () => (aiOpen.value = true) },
  { key: 'settings', label: 'Buch', title: 'Titel, Format und Bildunterschriften', icon: 'pi pi-pencil', disabled: !book.value || busy.value, command: openSettings },
  { key: 'narrowing', label: 'Auswahl', title: 'Auswahl ändern: Qualität, Ästhetik, Gesichter, Höchstzahl, Gewichte', icon: 'pi pi-filter', disabled: !book.value || busy.value, command: () => (narrowingOpen.value = true) },
  shareLinkItem({ name: 'fotos-photo-book', params: { id: bookId.value } }, book.value?.title),
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
        <div class="pbd-misfit">
          <span>
            {{ book.low_dpi_count === 1 ? 'Ein Foto ist' : `${book.low_dpi_count} Fotos sind` }} für {{ book.low_dpi_count === 1 ? 'seinen' : 'ihren' }} Platz zu klein und {{ book.low_dpi_count === 1 ? 'würde' : 'würden' }} unter 200 dpi gedruckt ({{ lowDpiPagesText }}, markiert mit <i class="pi pi-exclamation-triangle" aria-label="Warnsymbol" />).
            „Beheben“ ordnet die Seiten so, dass ein kleines Foto einen kleineren Platz bekommt, und setzt es sonst auf eine eigene Seite.
          </span>
          <span class="pbd-warn-actions">
            <Button label="Zeigen" icon="pi pi-arrow-down" size="small" severity="secondary" outlined @click="showNextLowDpi" />
            <Button label="Beheben" icon="pi pi-wrench" size="small" :loading="busy" @click="fixLowDpi" />
          </span>
        </div>
      </Message>
      <Message v-if="lowDpiFix" severity="success" closable class="pbd-warn" @close="lowDpiFix = null">
        {{ lowDpiFixText }}
      </Message>
      <Message v-if="book.edit_misfit_count" severity="info" :closable="false" class="pbd-warn">
        <div class="pbd-misfit">
          <span>
            {{ book.edit_misfit_count === 1 ? 'Eine Seite passt' : `${book.edit_misfit_count} Seiten passen` }}
            nach deiner Bearbeitung von Fotos nicht mehr gut (markiert mit <i class="pi pi-exclamation-circle" aria-label="Hinweissymbol" />).
            Seiten, deren Layout du selbst gewählt hast, bleiben, wie sie sind.
          </span>
          <Button label="Seiten anpassen" icon="pi pi-th-large" size="small" :loading="busy" @click="fitToEdits" />
        </div>
      </Message>

      <section class="pbd-section" aria-labelledby="pbd-cover">
        <h2 id="pbd-cover" class="pbd-heading">Titelseite</h2>
        <div class="pbd-cover" :style="{ aspectRatio: `${book.width_mm} / ${book.height_mm}` }">
          <img v-if="coverUrl" :src="coverUrl" alt="" :style="{ objectPosition: coverFocal }" />
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
          <li
            v-for="{ page, number } in ch.pages"
            :id="`pbd-page-${page.id}`"
            :key="page.id"
            class="pbd-page scroll-anchor"
            :class="{ 'pbd-page--flash': flashPage === page.id }"
            tabindex="-1"
          >
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
              <i
                v-if="page.edit_misfit"
                v-tooltip.top="misfitHint(page)"
                class="pi pi-exclamation-circle pbd-page-misfit"
                tabindex="0"
                :aria-label="misfitHint(page)"
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
    <PhotoBookNarrowingDialog v-if="book" v-model:visible="narrowingOpen" :book="book" @saved="book = $event" />
    <PhotoBookAiDialog v-if="book" v-model:visible="aiOpen" :book-id="book.id" @changed="load" />
    <RecapPlayer
      v-if="book"
      :open="showOpen"
      :photos="slideshowPhotos"
      :plan="slideshow"
      :title="book.title"
      :subtitle="book.subtitle"
      :music-url="showMusicUrl"
      :can-change-music="showTracks.length > 1"
      @change-music="nextTrack"
      @close="showOpen = false"
    />

    <Dialog v-model:visible="replaceOpen" class="dialog-md" modal header="Durch größeres Foto ersetzen">
      <p class="pbd-hint">
        Fotos derselben Szene, die an dieser Stelle mit mindestens 200 dpi gedruckt würden: aus derselben Serie oder ähnlich und kurz davor oder danach aufgenommen.
      </p>
      <p v-if="replaceLoading" class="pbd-hint"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> Suche ähnliche Fotos …</p>
      <Message v-else-if="replaceError" severity="error" :closable="false">{{ replaceError }}</Message>
      <p v-else-if="!replacements.length" class="pbd-hint">
        Kein ähnliches Foto ist groß genug. Setze das Foto auf eine eigene Seite oder nimm es aus dem Buch.
      </p>
      <ul v-else class="pbd-replacements">
        <li v-for="r in replacements" :key="r.photo_id">
          <button type="button" class="pbd-replacement" :disabled="busy" :aria-label="replacementLabel(r)" @click="chooseReplacement(r)">
            <img :src="replacementUrl(r)" alt="" loading="lazy" />
            <span class="pbd-replacement-dpi">{{ r.dpi }} dpi<template v-if="r.same_series"> · Serie</template></span>
          </button>
        </li>
      </ul>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="replaceOpen = false" />
      </template>
    </Dialog>

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
  border-radius: 6px;
  transition: box-shadow 0.3s;
}
.pbd-page:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.pbd-page--flash {
  box-shadow: 0 0 0 4px var(--p-primary-color);
}
.pbd-replacements {
  list-style: none;
  margin: 0;
  padding: var(--focus-ring-reach);
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-3);
}
.pbd-replacement {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  padding: 0;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  background: var(--p-content-background);
  color: var(--p-text-color);
  cursor: pointer;
  overflow: hidden;
}
.pbd-replacement:hover {
  background: var(--p-content-hover-background);
}
.pbd-replacement:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.pbd-replacement img {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  display: block;
}
.pbd-replacement-dpi {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  padding: 0 var(--space-2) var(--space-2);
  text-align: left;
}
.pbd-warn-actions {
  display: flex;
  flex-wrap: wrap;
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
.pbd-page-misfit {
  color: var(--p-text-muted-color);
  border-radius: 4px;
}
.pbd-misfit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
.pbd-page-misfit:focus-visible,
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
