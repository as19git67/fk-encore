<script setup lang="ts">
/**
 * One system of the house: what it is, how it is maintained (guides), its
 * units at different places (items) and what happened to it (notes), each
 * with photos; a guide shows its photos inline as `![…](media:<id>)`; the
 * spare parts that fit it, with where they lie and how many are left
 * — documentation/plans/haus-anlagen.md, stages 1 to 3.
 *
 * Everybody who sees the system and has `home.manage` writes guides, items
 * and notes; the system's own data, sharing, archiving and deleting stay
 * with its owner and the owners of its group (`canManage`).
 */
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Menu from 'primevue/menu'
import Message from 'primevue/message'
import MultiSelect from 'primevue/multiselect'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import { useConfirm } from 'primevue/useconfirm'
import type { MenuItem } from 'primevue/menuitem'
import PageLayout from '../components/layout/PageLayout.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ScrollX from '../components/layout/ScrollX.vue'
import MarkdownView from '../components/documents/MarkdownView.vue'
import MarkdownEditor from '../components/documents/MarkdownEditor.vue'
import HomeSystemDialog from '../components/home/HomeSystemDialog.vue'
import HomePhotos from '../components/home/HomePhotos.vue'
import HomePartDialog from '../components/home/HomePartDialog.vue'
import { useModuleBack } from '../composables/useModuleBack'
import { useAuthStore } from '../stores/auth'
import { parseLocalDate, toLocalIsoDate } from '../utils/dateFormat'
import { mediaImageMarkdown } from '../utils/markdown'
import {
  HOME_CATEGORY_ICONS,
  HOME_CATEGORY_LABELS,
  createHomeGuide,
  createHomeItem,
  createHomeNote,
  deleteHomeGuide,
  deleteHomeItem,
  deleteHomeNote,
  deleteHomeSystem,
  getHomeSystem,
  homeMediaUrl,
  listHomeGuideRevisions,
  listHomeParts,
  setHomeSystemParts,
  stockLabel,
  restoreHomeGuideRevision,
  updateHomeGuide,
  updateHomeItem,
  updateHomeNote,
  updateHomeSystem,
  uploadHomeMedia,
  type GuideRevision,
  type HomeGuide,
  type HomeItem,
  type HomeItemAttribute,
  type HomeMedia,
  type HomeMediaTargetKind,
  type HomeNote,
  type HomePartListItem,
  type HomeSystemDetail,
} from '../api/home'

const route = useRoute()
const auth = useAuthStore()
const confirm = useConfirm()
const { goBack } = useModuleBack('/haus', 'haus-anlagen')

const systemId = computed(() => Number(route.params.id))
const system = ref<HomeSystemDetail | null>(null)
const loading = ref(true)
const loadError = ref('')
const error = ref('')
const notice = ref('')

/** Writes guides, items and notes. */
const canWrite = computed(() => auth.hasPermission('home.manage'))
/** Changes the system itself. */
const canManage = computed(() => canWrite.value && !!system.value?.canManage)

async function load() {
  loadError.value = ''
  try {
    system.value = await getHomeSystem(systemId.value)
  } catch (err: any) {
    loadError.value = err?.message ?? 'Die Anlage konnte nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

watch(systemId, () => {
  loading.value = true
  system.value = null
  void load()
}, { immediate: true })

async function run(action: () => Promise<unknown>, failure: string): Promise<boolean> {
  error.value = ''
  try {
    await action()
    await load()
    return true
  } catch (err: any) {
    error.value = err?.message ?? failure
    return false
  }
}

/** The photos of the system itself or of one of its guides, items or notes. */
function photosOf(kind: HomeMediaTargetKind, id: number): HomeMedia[] {
  return (system.value?.media ?? []).filter((m) => m.targetKind === kind && m.targetId === id)
}

/** Where a guide's `media:<id>` image is loaded from. */
const mediaUrl = (id: number) => homeMediaUrl(id, 'full')

function fmtDate(iso: string | null): string {
  if (!iso) return '–'
  return parseLocalDate(iso).toLocaleDateString('de-DE')
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
}

const sharingLabel = computed(() => {
  const s = system.value
  if (!s) return ''
  const owner = s.ownerUserId === auth.user?.id ? '' : ` · von ${s.ownerName}`
  if (s.groupId === null) return `Privat${owner}`
  return `${s.household ? 'Haushalt' : 'Gruppe'} „${s.groupName ?? ''}“${owner}`
})

const facts = computed(() => {
  const s = system.value
  if (!s) return []
  return [
    { label: 'Bereich', value: HOME_CATEGORY_LABELS[s.category] },
    { label: 'Ort', value: s.location },
    { label: 'Hersteller', value: s.manufacturer },
    { label: 'Modell', value: s.model },
    { label: 'Eingebaut', value: s.installedOn ? fmtDate(s.installedOn) : null },
    { label: 'Geteilt', value: sharingLabel.value },
  ].filter((f) => f.value)
})

// ── The system itself ───────────────────────────────────────────────────────

const editOpen = ref(false)
const moreMenu = ref<InstanceType<typeof Menu> | null>(null)

const moreItems = computed<MenuItem[]>(() => {
  const s = system.value
  if (!s) return []
  return [
    {
      label: s.archived ? 'Wieder in Betrieb nehmen' : 'Archivieren',
      icon: s.archived ? 'pi pi-replay' : 'pi pi-box',
      command: () => void setArchived(!s.archived),
    },
    { separator: true },
    { label: 'Löschen …', icon: 'pi pi-trash', class: 'danger-item', command: confirmDeleteSystem },
  ]
})

async function onEdited() {
  editOpen.value = false
  await load()
}

async function setArchived(archived: boolean) {
  if (await run(() => updateHomeSystem(systemId.value, { archived }), 'Ändern fehlgeschlagen.')) {
    notice.value = archived
      ? 'Die Anlage ist archiviert und steht nicht mehr in der Liste.'
      : 'Die Anlage steht wieder in der Liste.'
  }
}

function confirmDeleteSystem() {
  const s = system.value
  if (!s) return
  confirm.require({
    header: 'Anlage löschen',
    message: `„${s.name}“ mit ${s.guides.length} Anleitung(en), ${s.items.length} Einzelteil(en), ${s.notes.length} Notiz(en) und ${s.media.length} Foto(s) löschen? Das lässt sich nicht rückgängig machen. Archivieren behält alles.`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Endgültig löschen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteHomeSystem(systemId.value)
        goBack()
      } catch (err: any) {
        error.value = err?.message ?? 'Löschen fehlgeschlagen.'
      }
    },
  })
}

// ── Guides ──────────────────────────────────────────────────────────────────

const GUIDE_TEMPLATE = '1. \n2. \n\n> [!WARNING]\n> \n'

const guideOpen = ref(false)
const guideEditing = ref<HomeGuide | null>(null)
const guideTitle = ref('')
const guideBody = ref('')
const guideSaving = ref(false)

const guideError = ref('')
const guideEditor = ref<InstanceType<typeof MarkdownEditor> | null>(null)
const guidePhotoInput = ref<HTMLInputElement | null>(null)
const guidePhotoUploading = ref(false)

function openGuide(guide: HomeGuide | null) {
  guideError.value = ''
  guideEditing.value = guide
  guideTitle.value = guide?.title ?? ''
  guideBody.value = guide?.body ?? GUIDE_TEMPLATE
  guideOpen.value = true
}

async function saveGuide() {
  if (!guideTitle.value.trim() || guideSaving.value) return
  guideSaving.value = true
  const editing = guideEditing.value
  const ok = await run(
    () => editing
      ? updateHomeGuide(systemId.value, editing.id, { title: guideTitle.value, body: guideBody.value })
      : createHomeGuide(systemId.value, { title: guideTitle.value, body: guideBody.value }),
    'Die Anleitung konnte nicht gespeichert werden.',
  )
  guideSaving.value = false
  if (ok) guideOpen.value = false
}

/**
 * "Foto einfügen": the photo belongs to the guide, so a new guide is saved
 * first; the image line goes where the cursor is.
 */
async function onGuidePhoto(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  guideError.value = ''
  if (!guideTitle.value.trim()) {
    guideError.value = 'Gib der Anleitung zuerst einen Titel, dann lässt sich ein Foto einfügen.'
    return
  }
  guidePhotoUploading.value = true
  try {
    let guideId = guideEditing.value?.id
    if (guideId === undefined) {
      guideId = (await createHomeGuide(systemId.value, { title: guideTitle.value, body: guideBody.value })).id
      await load()
      guideEditing.value = system.value?.guides.find((g) => g.id === guideId) ?? null
    }
    const media = await uploadHomeMedia(systemId.value, { kind: 'guide', id: guideId }, file)
    guideEditor.value?.insertText(mediaImageMarkdown(media.id), 'cursor')
    void load()
  } catch (err: any) {
    guideError.value = err?.message ?? 'Das Foto konnte nicht eingefügt werden.'
  } finally {
    guidePhotoUploading.value = false
  }
}

function confirmDeleteGuide(guide: HomeGuide) {
  confirm.require({
    header: 'Anleitung löschen',
    message: `Anleitung „${guide.title}“ samt ihren früheren Fassungen löschen?`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: () => void run(() => deleteHomeGuide(systemId.value, guide.id), 'Löschen fehlgeschlagen.'),
  })
}

/** Move a guide one place; the guides are renumbered 0, 1, 2 … on the way. */
async function moveGuide(guide: HomeGuide, direction: -1 | 1) {
  const list = [...(system.value?.guides ?? [])]
  const index = list.findIndex((g) => g.id === guide.id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= list.length) return
  list.splice(index, 1)
  list.splice(target, 0, guide)
  await run(async () => {
    for (const [sort, g] of list.entries()) {
      if (g.sort !== sort) await updateHomeGuide(systemId.value, g.id, { sort })
    }
  }, 'Verschieben fehlgeschlagen.')
}

const revisionsOpen = ref(false)
const revisionsGuide = ref<HomeGuide | null>(null)
const revisions = ref<GuideRevision[]>([])
const revisionsLoading = ref(false)
const shownRevision = ref<GuideRevision | null>(null)

async function openRevisions(guide: HomeGuide) {
  revisionsGuide.value = guide
  revisions.value = []
  shownRevision.value = null
  revisionsOpen.value = true
  revisionsLoading.value = true
  try {
    revisions.value = (await listHomeGuideRevisions(systemId.value, guide.id)).revisions
    shownRevision.value = revisions.value[0] ?? null
  } catch (err: any) {
    error.value = err?.message ?? 'Frühere Fassungen konnten nicht geladen werden.'
    revisionsOpen.value = false
  } finally {
    revisionsLoading.value = false
  }
}

async function restoreRevision(revision: GuideRevision) {
  const guide = revisionsGuide.value
  if (!guide) return
  if (await run(() => restoreHomeGuideRevision(systemId.value, guide.id, revision.id), 'Wiederherstellen fehlgeschlagen.')) {
    revisionsOpen.value = false
    notice.value = `Die Fassung vom ${fmtDateTime(revision.editedAt)} ist wiederhergestellt. Die bisherige steht jetzt unter „Frühere Fassungen“.`
  }
}

// ── Items in place ──────────────────────────────────────────────────────────

const itemOpen = ref(false)
const itemEditing = ref<HomeItem | null>(null)
const itemLabel = ref('')
const itemLocation = ref('')
const itemAttributes = ref<HomeItemAttribute[]>([])
const itemPartId = ref<number | null>(null)
const itemSaving = ref(false)

/** The keys used on this system's other items, offered first for a new one. */
const knownKeys = computed(() => {
  const keys: string[] = []
  for (const item of system.value?.items ?? []) {
    for (const a of item.attributes) if (!keys.includes(a.key)) keys.push(a.key)
  }
  return keys
})

function openItem(item: HomeItem | null) {
  itemEditing.value = item
  itemLabel.value = item?.label ?? ''
  itemLocation.value = item?.location ?? ''
  itemPartId.value = item?.partId ?? null
  void loadAllParts()
  itemAttributes.value = item
    ? item.attributes.map((a) => ({ ...a }))
    : knownKeys.value.length
      ? knownKeys.value.map((key) => ({ key, value: '' }))
      : [{ key: '', value: '' }]
  itemOpen.value = true
}

function addAttribute() {
  itemAttributes.value.push({ key: '', value: '' })
}

function removeAttribute(index: number) {
  itemAttributes.value.splice(index, 1)
}

async function saveItem() {
  if (!itemLabel.value.trim() || itemSaving.value) return
  itemSaving.value = true
  const fields = {
    label: itemLabel.value,
    location: itemLocation.value.trim() || null,
    attributes: itemAttributes.value.filter((a) => a.key.trim() || a.value.trim()),
    // Sent only when changed: a part the caller cannot see stays on the item.
    ...(itemPartId.value !== (itemEditing.value?.partId ?? null) ? { partId: itemPartId.value } : {}),
  }
  const editing = itemEditing.value
  const ok = await run(
    () => editing
      ? updateHomeItem(systemId.value, editing.id, fields)
      : createHomeItem(systemId.value, fields),
    'Das Einzelteil konnte nicht gespeichert werden.',
  )
  itemSaving.value = false
  if (ok) itemOpen.value = false
}

function confirmDeleteItem(item: HomeItem) {
  confirm.require({
    header: 'Einzelteil löschen',
    message: `„${item.label}“ aus der Liste löschen?`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: () => void run(() => deleteHomeItem(systemId.value, item.id), 'Löschen fehlgeschlagen.'),
  })
}

/** Columns of the item table: every key any item has, in first-seen order. */
const attributeColumns = computed(() => knownKeys.value)

const itemsHaveParts = computed(() => (system.value?.items ?? []).some((i) => i.partId !== null))

function attributeOf(item: HomeItem, key: string): string {
  return item.attributes.find((a) => a.key === key)?.value ?? ''
}

// ── Spare parts ─────────────────────────────────────────────────────────────

/** Every part the caller sees, for the choices; loaded when needed. */
const allParts = ref<HomePartListItem[]>([])
const allPartsLoaded = ref(false)

async function loadAllParts(force = false) {
  if (allPartsLoaded.value && !force) return
  try {
    allParts.value = (await listHomeParts()).parts
    allPartsLoaded.value = true
  } catch (err: any) {
    error.value = err?.message ?? 'Ersatzteile konnten nicht geladen werden.'
  }
}

const partOptions = computed(() =>
  allParts.value.map((p) => ({
    label: [p.name, p.partNumber].filter(Boolean).join(' · '),
    value: p.id,
  })),
)

const partsOpen = ref(false)
const partsChoice = ref<number[]>([])
const partsSaving = ref(false)
const newPartOpen = ref(false)

async function openParts() {
  partsChoice.value = (system.value?.parts ?? []).map((p) => p.id)
  partsOpen.value = true
  await loadAllParts(true)
}

async function saveParts() {
  if (partsSaving.value) return
  partsSaving.value = true
  const ok = await run(
    () => setHomeSystemParts(systemId.value, partsChoice.value),
    'Die Ersatzteile konnten nicht zugeordnet werden.',
  )
  partsSaving.value = false
  if (ok) partsOpen.value = false
}

/** A part made from the choice dialog is chosen right away. */
async function onPartCreated(id: number) {
  newPartOpen.value = false
  await loadAllParts(true)
  if (!partsChoice.value.includes(id)) partsChoice.value = [...partsChoice.value, id]
}

// ── Notes ───────────────────────────────────────────────────────────────────

/** The quickest entry on the page: "Notiz" in the header jumps to the field. */
function focusNoteInput() {
  const el = document.getElementById('hs-note-input')
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el?.focus({ preventScroll: true })
}

const noteDate = ref<Date>(new Date())
const noteBody = ref('')
const noteSaving = ref(false)

async function addNote() {
  if (!noteBody.value.trim() || noteSaving.value) return
  noteSaving.value = true
  const ok = await run(
    () => createHomeNote(systemId.value, { body: noteBody.value, notedOn: toLocalIsoDate(noteDate.value) }),
    'Die Notiz konnte nicht gespeichert werden.',
  )
  noteSaving.value = false
  if (ok) {
    noteBody.value = ''
    noteDate.value = new Date()
  }
}

const noteEditOpen = ref(false)
const noteEditing = ref<HomeNote | null>(null)
const noteEditDate = ref<Date>(new Date())
const noteEditBody = ref('')

function openNoteEdit(note: HomeNote) {
  noteEditing.value = note
  noteEditDate.value = parseLocalDate(note.notedOn)
  noteEditBody.value = note.body
  noteEditOpen.value = true
}

async function saveNoteEdit() {
  const note = noteEditing.value
  if (!note || !noteEditBody.value.trim()) return
  const ok = await run(
    () => updateHomeNote(systemId.value, note.id, { body: noteEditBody.value, notedOn: toLocalIsoDate(noteEditDate.value) }),
    'Die Notiz konnte nicht gespeichert werden.',
  )
  if (ok) noteEditOpen.value = false
}

function confirmDeleteNote(note: HomeNote) {
  confirm.require({
    header: 'Notiz löschen',
    message: `Notiz vom ${fmtDate(note.notedOn)} löschen?`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: () => void run(() => deleteHomeNote(systemId.value, note.id), 'Löschen fehlgeschlagen.'),
  })
}
</script>

<template>
  <PageLayout
    :title="system?.name ?? 'Anlage'"
    :hint="system?.archived ? 'Archiviert' : undefined"
    width="normal"
    :ready="!loading"
    sticky-header
  >
    <template #back>
      <Button icon="pi pi-arrow-left" text rounded aria-label="Zurück" @click="goBack" />
    </template>

    <template #actions>
      <template v-if="system">
        <Button v-if="canManage" label="Bearbeiten" icon="pi pi-pencil" severity="secondary" size="small" @click="editOpen = true" />
        <Button v-if="canWrite" label="Notiz" icon="pi pi-plus" size="small" @click="focusNoteInput" />
      </template>
    </template>

    <template #menu>
      <template v-if="canManage && system">
        <Button
          icon="pi pi-ellipsis-v"
          text
          rounded
          severity="secondary"
          aria-label="Weitere Aktionen"
          aria-haspopup="true"
          v-tooltip.bottom="'Weitere Aktionen'"
          @click="(e: Event) => moreMenu?.toggle(e)"
        />
        <Menu ref="moreMenu" :model="moreItems" :popup="true" />
      </template>
    </template>

    <template #notice>
      <ErrorBanner v-if="loadError" :message="loadError" @retry="load" />
      <Message v-if="error" severity="error" closable @close="error = ''">{{ error }}</Message>
      <Message v-if="notice" severity="success" closable @close="notice = ''">{{ notice }}</Message>
    </template>

    <PageSkeleton v-if="loading" variant="list" :count="4" />

    <div v-else-if="system" class="hs-page">
      <section class="hs-card" aria-labelledby="hs-facts">
        <h2 id="hs-facts" class="hs-heading">
          <i :class="HOME_CATEGORY_ICONS[system.category]" aria-hidden="true" /> Steckbrief
        </h2>
        <dl class="hs-facts">
          <template v-for="f in facts" :key="f.label">
            <dt>{{ f.label }}</dt>
            <dd>{{ f.value }}</dd>
          </template>
        </dl>
        <MarkdownView v-if="system.description" :source="system.description" class="hs-description" />
        <HomePhotos
          :system-id="system.id"
          :target="{ kind: 'system', id: system.id }"
          :photos="photosOf('system', system.id)"
          :can-write="canWrite"
          subject="der Anlage"
          class="hs-photos"
          @changed="load"
        />
      </section>

      <section class="hs-card" aria-labelledby="hs-guides">
        <div class="hs-section-head">
          <h2 id="hs-guides" class="hs-heading">Anleitungen</h2>
          <Button v-if="canWrite" label="Neue Anleitung" icon="pi pi-plus" size="small" text @click="openGuide(null)" />
        </div>
        <p v-if="system.guides.length === 0" class="hs-empty">
          Noch keine Anleitung. Schreib auf, wie die wiederkehrende Arbeit geht: Schritt für Schritt, mit Warnhinweisen.
        </p>
        <details v-for="(g, index) in system.guides" :key="g.id" class="hs-guide" :open="index === 0">
          <summary class="hs-guide-summary">
            <span class="hs-guide-title">{{ g.title }}</span>
          </summary>
          <MarkdownView v-if="g.body.trim()" :source="g.body" :media-url="mediaUrl" />
          <p v-else class="hs-empty">Noch kein Text.</p>
          <div class="hs-guide-foot">
            <span class="hs-meta">
              Geändert {{ fmtDateTime(g.updatedAt) }}<template v-if="g.updatedByName"> von {{ g.updatedByName }}</template>
            </span>
            <span class="hs-guide-actions">
              <Button
                v-if="g.revisionCount > 0"
                icon="pi pi-history"
                :label="`Frühere Fassungen (${g.revisionCount})`"
                text
                size="small"
                severity="secondary"
                @click="openRevisions(g)"
              />
              <template v-if="canWrite">
                <Button icon="pi pi-arrow-up" text rounded size="small" severity="secondary" aria-label="Nach oben" :disabled="index === 0" @click="moveGuide(g, -1)" />
                <Button icon="pi pi-arrow-down" text rounded size="small" severity="secondary" aria-label="Nach unten" :disabled="index === system.guides.length - 1" @click="moveGuide(g, 1)" />
                <Button icon="pi pi-pencil" text rounded size="small" severity="secondary" aria-label="Anleitung bearbeiten" @click="openGuide(g)" />
                <Button icon="pi pi-trash" text rounded size="small" severity="danger" aria-label="Anleitung löschen" @click="confirmDeleteGuide(g)" />
              </template>
            </span>
          </div>
        </details>
      </section>

      <section class="hs-card" aria-labelledby="hs-items">
        <div class="hs-section-head">
          <h2 id="hs-items" class="hs-heading">Einzelteile vor Ort</h2>
          <Button v-if="canWrite" label="Einzelteil" icon="pi pi-plus" size="small" text @click="openItem(null)" />
        </div>
        <p v-if="system.items.length === 0" class="hs-empty">
          Für Anlagen aus mehreren gleichen Teilen an verschiedenen Stellen, etwa die Perlatoren an jeder Armatur.
        </p>
        <ScrollX v-else>
          <table class="hs-table">
            <thead>
              <tr>
                <th scope="col">Teil</th>
                <th scope="col">Ort</th>
                <th v-for="key in attributeColumns" :key="key" scope="col">{{ key }}</th>
                <th v-if="itemsHaveParts" scope="col">Ersatzteil</th>
                <th scope="col">Fotos</th>
                <th v-if="canWrite" scope="col" aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in system.items" :key="item.id">
                <td>{{ item.label }}</td>
                <td>{{ item.location ?? '' }}</td>
                <td v-for="key in attributeColumns" :key="key">{{ attributeOf(item, key) }}</td>
                <td v-if="itemsHaveParts">
                  <RouterLink v-if="item.partId" :to="{ name: 'haus-ersatzteil', params: { id: item.partId } }">
                    {{ item.partName }}
                  </RouterLink>
                </td>
                <td>
                  <HomePhotos
                    :system-id="system.id"
                    :target="{ kind: 'item', id: item.id }"
                    :photos="photosOf('item', item.id)"
                    :can-write="canWrite"
                    :subject="`von ${item.label}`"
                    compact
                    @changed="load"
                  />
                </td>
                <td v-if="canWrite" class="hs-row-actions">
                  <Button icon="pi pi-pencil" text rounded size="small" severity="secondary" :aria-label="`${item.label} bearbeiten`" @click="openItem(item)" />
                  <Button icon="pi pi-trash" text rounded size="small" severity="danger" :aria-label="`${item.label} löschen`" @click="confirmDeleteItem(item)" />
                </td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </section>

      <section class="hs-card" aria-labelledby="hs-parts">
        <div class="hs-section-head">
          <h2 id="hs-parts" class="hs-heading">Ersatzteile</h2>
          <Button v-if="canWrite" label="Zuordnen" icon="pi pi-link" size="small" text @click="openParts" />
        </div>
        <p v-if="system.parts.length === 0" class="hs-empty">
          Welche Dichtungen, Filter oder Kartuschen passen, wo sie liegen und wie viele noch da sind.
        </p>
        <ul v-else class="hs-parts">
          <li v-for="p in system.parts" :key="p.id" class="hs-part">
            <RouterLink :to="{ name: 'haus-ersatzteil', params: { id: p.id } }" class="hs-part-name">{{ p.name }}</RouterLink>
            <span v-if="p.specification || p.partNumber" class="hs-meta">
              {{ [p.partNumber, p.specification].filter(Boolean).join(' · ') }}
            </span>
            <span class="hs-part-where">
              <span v-if="p.storageLocation"><i class="pi pi-map-marker" aria-hidden="true" /> {{ p.storageLocation }}</span>
              <Tag v-if="p.stock === 0" severity="warn" icon="pi pi-exclamation-circle" :value="stockLabel(p.stock)" />
              <span v-else-if="p.stock !== null" class="hs-meta">{{ stockLabel(p.stock) }}</span>
            </span>
          </li>
        </ul>
      </section>

      <section class="hs-card" aria-labelledby="hs-notes">
        <h2 id="hs-notes" class="hs-heading">Notizen</h2>
        <form v-if="canWrite" class="hs-note-form" @submit.prevent="addNote">
          <DatePicker v-model="noteDate" date-format="dd.mm.yy" :max-date="new Date()" aria-label="Datum der Notiz" class="hs-note-date" />
          <Textarea
            id="hs-note-input"
            v-model="noteBody"
            rows="2"
            auto-resize
            aria-label="Neue Notiz"
            placeholder="Was wurde gemacht? z. B. „Steuerventil getauscht“"
            class="hs-note-text"
          />
          <Button type="submit" label="Hinzufügen" icon="pi pi-check" :disabled="!noteBody.trim()" :loading="noteSaving" />
        </form>
        <p v-if="system.notes.length === 0" class="hs-empty">Noch keine Notiz.</p>
        <ol v-else class="hs-notes">
          <li v-for="n in system.notes" :key="n.id" class="hs-note">
            <div class="hs-note-head">
              <strong>{{ fmtDate(n.notedOn) }}</strong>
              <span v-if="n.authorName" class="hs-meta">{{ n.authorName }}</span>
              <span v-if="canWrite" class="hs-note-actions">
                <Button icon="pi pi-pencil" text rounded size="small" severity="secondary" aria-label="Notiz bearbeiten" @click="openNoteEdit(n)" />
                <Button icon="pi pi-trash" text rounded size="small" severity="danger" aria-label="Notiz löschen" @click="confirmDeleteNote(n)" />
              </span>
            </div>
            <p class="hs-note-body">{{ n.body }}</p>
            <HomePhotos
              v-if="canWrite || photosOf('note', n.id).length"
              :system-id="system.id"
              :target="{ kind: 'note', id: n.id }"
              :photos="photosOf('note', n.id)"
              :can-write="canWrite"
              :subject="`der Notiz vom ${fmtDate(n.notedOn)}`"
              @changed="load"
            />
          </li>
        </ol>
      </section>
    </div>

    <HomeSystemDialog v-if="editOpen && system" v-model:visible="editOpen" :system="system" @saved="onEdited" />

    <Dialog v-model:visible="guideOpen" class="dialog-lg" modal :header="guideEditing ? 'Anleitung bearbeiten' : 'Neue Anleitung'">
      <div class="hs-form">
        <label for="hs-guide-title">Titel</label>
        <InputText id="hs-guide-title" v-model="guideTitle" autofocus placeholder="z. B. Kartusche tauschen" />
        <Message v-if="guideError" severity="error" closable @close="guideError = ''">{{ guideError }}</Message>
        <div class="hs-guide-hint">
          <p class="hs-meta">
            Nummerierte Schritte mit „1.“, Warnungen mit „&gt; [!WARNING]“, Hinweise mit „&gt; [!NOTE]“.
          </p>
          <input
            ref="guidePhotoInput"
            type="file"
            accept="image/*"
            class="hs-file-input"
            tabindex="-1"
            aria-hidden="true"
            @change="onGuidePhoto"
          />
          <Button
            label="Foto einfügen"
            icon="pi pi-image"
            severity="secondary"
            size="small"
            :loading="guidePhotoUploading"
            @click="guidePhotoInput?.click()"
          />
        </div>
        <MarkdownEditor
          ref="guideEditor"
          v-model="guideBody"
          aria-label="Text der Anleitung"
          :media-url="mediaUrl"
          @save="saveGuide"
        />
      </div>
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="guideOpen = false" />
        <Button label="Speichern" icon="pi pi-check" :disabled="!guideTitle.trim()" :loading="guideSaving" @click="saveGuide" />
      </template>
    </Dialog>

    <Dialog v-model:visible="revisionsOpen" class="dialog-lg" modal :header="`Frühere Fassungen: ${revisionsGuide?.title ?? ''}`">
      <PageSkeleton v-if="revisionsLoading" variant="list" :count="3" />
      <div v-else class="hs-revisions">
        <ul class="hs-revision-list" aria-label="Fassungen">
          <li v-for="r in revisions" :key="r.id">
            <Button
              :label="fmtDateTime(r.editedAt)"
              :severity="shownRevision?.id === r.id ? 'primary' : 'secondary'"
              :text="shownRevision?.id !== r.id"
              size="small"
              :aria-pressed="shownRevision?.id === r.id"
              @click="shownRevision = r"
            />
            <span v-if="r.editedByName" class="hs-meta">{{ r.editedByName }}</span>
          </li>
        </ul>
        <div v-if="shownRevision" class="hs-revision-body">
          <h3 class="hs-revision-title">{{ shownRevision.title }}</h3>
          <MarkdownView v-if="shownRevision.body.trim()" :source="shownRevision.body" :media-url="mediaUrl" />
          <p v-else class="hs-empty">Leer.</p>
        </div>
      </div>
      <template #footer>
        <Button label="Schließen" text severity="secondary" @click="revisionsOpen = false" />
        <Button
          v-if="canWrite && shownRevision"
          label="Diese Fassung wiederherstellen"
          icon="pi pi-replay"
          @click="restoreRevision(shownRevision)"
        />
      </template>
    </Dialog>

    <Dialog v-model:visible="itemOpen" class="dialog-md" modal :header="itemEditing ? 'Einzelteil bearbeiten' : 'Neues Einzelteil'">
      <form class="hs-form" @submit.prevent="saveItem">
        <label for="hs-item-label">Bezeichnung</label>
        <InputText id="hs-item-label" v-model="itemLabel" autofocus placeholder="z. B. Küche" />
        <label for="hs-item-location">Ort</label>
        <InputText id="hs-item-location" v-model="itemLocation" placeholder="z. B. Spüle, Erdgeschoss" />
        <span class="hs-label">Eigenschaften</span>
        <div v-for="(a, i) in itemAttributes" :key="i" class="hs-attr">
          <InputText v-model="a.key" :aria-label="`Eigenschaft ${i + 1}`" placeholder="z. B. Gewinde" />
          <InputText v-model="a.value" :aria-label="`Wert ${i + 1}`" placeholder="z. B. M24" />
          <Button icon="pi pi-times" text rounded severity="secondary" :aria-label="`Eigenschaft ${i + 1} entfernen`" @click="removeAttribute(i)" />
        </div>
        <Button label="Eigenschaft" icon="pi pi-plus" text size="small" class="hs-add-attr" @click="addAttribute" />
        <label for="hs-item-part">Ersatzteil</label>
        <Select
          input-id="hs-item-part"
          v-model="itemPartId"
          :options="partOptions"
          option-label="label"
          option-value="value"
          filter
          show-clear
          placeholder="Keins"
          empty-message="Noch kein Ersatzteil angelegt"
        />
      </form>
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="itemOpen = false" />
        <Button label="Speichern" icon="pi pi-check" :disabled="!itemLabel.trim()" :loading="itemSaving" @click="saveItem" />
      </template>
    </Dialog>

    <Dialog v-model:visible="partsOpen" class="dialog-md" modal header="Ersatzteile zuordnen">
      <div class="hs-form">
        <label for="hs-parts-choice">Passende Ersatzteile</label>
        <MultiSelect
          input-id="hs-parts-choice"
          v-model="partsChoice"
          :options="partOptions"
          option-label="label"
          option-value="value"
          filter
          display="chip"
          placeholder="Ersatzteile wählen"
          empty-message="Noch kein Ersatzteil angelegt"
        />
        <Button
          label="Neues Ersatzteil"
          icon="pi pi-plus"
          text
          size="small"
          class="hs-add-attr"
          @click="newPartOpen = true"
        />
      </div>
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="partsOpen = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="partsSaving" @click="saveParts" />
      </template>
    </Dialog>

    <HomePartDialog v-if="newPartOpen" v-model:visible="newPartOpen" @saved="onPartCreated" />

    <Dialog v-model:visible="noteEditOpen" class="dialog-md" modal header="Notiz bearbeiten">
      <div class="hs-form">
        <label for="hs-note-edit-date">Datum</label>
        <DatePicker input-id="hs-note-edit-date" v-model="noteEditDate" date-format="dd.mm.yy" :max-date="new Date()" />
        <label for="hs-note-edit-body">Text</label>
        <Textarea id="hs-note-edit-body" v-model="noteEditBody" rows="4" auto-resize />
      </div>
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="noteEditOpen = false" />
        <Button label="Speichern" icon="pi pi-check" :disabled="!noteEditBody.trim()" @click="saveNoteEdit" />
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.hs-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.hs-card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  background: var(--p-content-background);
  padding: var(--space-3) var(--space-4);
  min-width: 0;
}
.hs-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.hs-heading {
  font-size: var(--text-xl);
  margin: 0 0 var(--space-2);
}
.hs-heading i {
  color: var(--p-primary-color);
}
.hs-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-1) var(--space-3);
  margin: 0 0 var(--space-3);
}
.hs-facts dt {
  color: var(--p-text-muted-color);
}
.hs-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.hs-description {
  margin-top: var(--space-2);
}
.hs-photos {
  margin-top: var(--space-2);
}
.hs-guide-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.hs-guide-hint .hs-meta {
  margin: 0;
}
.hs-file-input {
  display: none;
}
.hs-empty,
.hs-meta {
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
}
.hs-empty {
  margin: 0 0 var(--space-2);
}
.hs-guide {
  border-top: 1px solid var(--p-content-border-color);
  padding: var(--space-2) 0;
}
.hs-guide:first-of-type {
  border-top: 0;
}
.hs-guide-summary {
  cursor: pointer;
  padding: var(--space-1) 0;
  font-weight: 600;
  border-radius: 4px;
}
.hs-guide-summary:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.hs-guide[open] > .hs-guide-summary {
  margin-bottom: var(--space-2);
}
.hs-guide-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
}
.hs-guide-actions,
.hs-note-actions,
.hs-row-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.hs-table {
  border-collapse: collapse;
  width: 100%;
}
.hs-table th,
.hs-table td {
  text-align: left;
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: middle;
  white-space: nowrap;
}
.hs-table th {
  color: var(--p-text-muted-color);
  font-weight: 600;
  font-size: var(--text-md);
}
.hs-row-actions {
  justify-content: flex-end;
}
.hs-parts {
  list-style: none;
  margin: 0;
  padding: 0;
}
.hs-part {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-top: 1px solid var(--p-content-border-color);
  padding: var(--space-2) 0;
}
.hs-part:first-child {
  border-top: 0;
}
.hs-part-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.hs-part-where {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-md);
  overflow-wrap: anywhere;
}
.hs-note-form {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: flex-start;
  margin-bottom: var(--space-3);
}
.hs-note-date {
  width: 9rem;
}
.hs-note-text {
  flex: 1 1 16rem;
  min-width: 0;
}
.hs-notes {
  list-style: none;
  margin: 0;
  padding: 0;
}
.hs-note {
  border-top: 1px solid var(--p-content-border-color);
  padding: var(--space-2) 0;
}
.hs-note:first-child {
  border-top: 0;
}
.hs-note-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.hs-note-actions {
  margin-left: auto;
}
.hs-note-body {
  margin: var(--space-1) 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.hs-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hs-form label,
.hs-label {
  font-size: var(--text-md);
  color: var(--p-text-muted-color);
  margin-top: 6px;
}
.hs-attr {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: var(--space-2);
  align-items: center;
}
.hs-attr :deep(input) {
  min-width: 0;
}
.hs-add-attr {
  align-self: flex-start;
}
.hs-revisions {
  display: grid;
  grid-template-columns: minmax(10rem, max-content) 1fr;
  gap: var(--space-3);
}
@media (max-width: 639px) {
  .hs-revisions {
    grid-template-columns: 1fr;
  }
}
.hs-revision-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.hs-revision-list li {
  display: flex;
  flex-direction: column;
}
.hs-revision-body {
  min-width: 0;
}
.hs-revision-title {
  font-size: var(--text-lg);
  margin: 0 0 var(--space-2);
}
</style>
