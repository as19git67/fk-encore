<script setup lang="ts">
/**
 * One photo book (documentation/plans/fotobuch.md): the cover, then every
 * chapter with its pages as the PDF lays them out. Chapter titles are edited
 * in place, each page picks one of the layouts for its number of photos, and
 * a photo can become the cover or leave the book. "Neu verteilen" lays the
 * book out again from its source; the PDF comes from the export dialog.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Menu from 'primevue/menu'
import type { MenuItem } from 'primevue/menuitem'
import Message from 'primevue/message'
import Select from 'primevue/select'
import PageLayout from '../components/layout/PageLayout.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import ResponsiveToolbar, { type ToolbarItem } from '../components/ResponsiveToolbar.vue'
import PhotoBookPagePreview from '../components/photobook/PhotoBookPagePreview.vue'
import PhotoBookExportDialog from '../components/photobook/PhotoBookExportDialog.vue'
import { useModuleBack } from '../composables/useModuleBack'
import {
  PHOTO_BOOK_FORMATS,
  deletePhotoBook,
  getPhotoBook,
  photoBookThumbUrl,
  rebuildPhotoBook,
  removePhotoFromBookPage,
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
  pages: { page: PhotoBookPage; number: number }[]
}

const chapters = computed<ChapterBlock[]>(() => {
  const b = book.value
  if (!b) return []
  const blocks = new Map<number | null, ChapterBlock>()
  for (const c of b.chapters) blocks.set(c.id, { id: c.id, title: c.title, subtitle: c.subtitle, pages: [] })
  b.pages.forEach((page, i) => {
    let block = blocks.get(page.chapter_id)
    if (!block) {
      block = { id: page.chapter_id, title: 'Ohne Kapitel', subtitle: null, pages: [] }
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

// ── pages and photos ────────────────────────────────────────────────────

function changeLayout(page: PhotoBookPage, layout: string) {
  if (layout === page.layout) return
  void apply(() => setPhotoBookPageLayout(bookId.value, page.id, layout))
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

function openSettings() {
  if (!book.value) return
  draftTitle.value = book.value.title
  draftSubtitle.value = book.value.subtitle ?? ''
  draftFormat.value = book.value.format
  settingsOpen.value = true
}

async function saveSettings() {
  if (!draftTitle.value.trim()) return
  await apply(() => updatePhotoBook(bookId.value, {
    title: draftTitle.value.trim(),
    subtitle: draftSubtitle.value.trim() || null,
    format: draftFormat.value,
  }))
  if (!actionError.value) settingsOpen.value = false
}

function confirmRebuild() {
  confirm.require({
    header: 'Neu verteilen?',
    message: 'Kapitel und Seiten werden aus der Quelle neu gebildet. Geänderte Kapiteltitel, Layouts und herausgenommene Fotos gehen dabei verloren.',
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
  { key: 'settings', label: 'Buch', title: 'Titel und Format', icon: 'pi pi-pencil', disabled: !book.value || busy.value, command: openSettings },
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
            </div>
          </li>
        </ul>
      </section>
    </template>

    <Menu ref="slotMenu" :model="slotMenuItems" popup />

    <PhotoBookExportDialog v-if="book" v-model:visible="exportOpen" :book="book" @saved="book = $event" />

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
