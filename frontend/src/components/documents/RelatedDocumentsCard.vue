<script setup lang="ts">
/**
 * Verwandte Dokumente (#1478): what else belongs next to this document, in
 * groups that each say why — same origin folder, same correspondent close in
 * time, same Sammelmappe, similar text. The card loads after the document
 * itself and never blocks the page; a failed load shows a quiet line, not a
 * toast, and an empty answer shows an empty state rather than nothing.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import DocumentThumbnail from '../DocumentThumbnail.vue'
import AddToCollectionDialog from './AddToCollectionDialog.vue'
import { getRelatedDocuments, type RelatedDocument, type RelatedGroup, type RelatedReason } from '../../api/documents'
import { parseLocalDate } from '../../utils/dateFormat'

const props = defineProps<{
  documentId: number
}>()

const emit = defineEmits<{
  /** A related document was put into a Sammelmappe; the page may refresh its own card. */
  (e: 'collection-changed'): void
}>()

const router = useRouter()
const groups = ref<RelatedGroup[]>([])
const loading = ref(false)
const failed = ref(false)

const REASON_TITLES: Record<RelatedReason, string> = {
  same_folder: 'Aus demselben Ordner',
  same_correspondent_nearby: 'Vom selben Absender, zeitlich nah',
  same_collection: 'In derselben Sammelmappe',
  semantic: 'Ähnlicher Inhalt',
}

const REASON_ICONS: Record<RelatedReason, string> = {
  same_folder: 'pi pi-folder-open',
  same_correspondent_nearby: 'pi pi-envelope',
  same_collection: 'pi pi-folder',
  semantic: 'pi pi-sparkles',
}

function groupTitle(g: RelatedGroup): string {
  const base = REASON_TITLES[g.reason]
  return g.label ? `${base}: ${g.label}` : base
}

const total = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))

async function load(id: number) {
  if (!Number.isFinite(id)) return
  loading.value = true
  failed.value = false
  try {
    groups.value = (await getRelatedDocuments(id)).groups
  } catch {
    groups.value = []
    failed.value = true
  } finally {
    loading.value = false
  }
}

watch(() => props.documentId, (id) => { void load(id) }, { immediate: true })

function formatDocDate(iso: string | null): string {
  if (!iso) return ''
  return parseLocalDate(iso).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

function open(item: RelatedDocument) {
  void router.push({ name: 'dokumente-detail', params: { id: item.id } })
}

function openCollection(g: RelatedGroup) {
  if (g.collection_id == null) return
  void router.push({ name: 'dokumente-mappe', params: { id: g.collection_id } })
}

// "In Sammelmappe" for one related document — the same dialog the page uses
// for the document itself, pointed at the neighbour.
const addTarget = ref<number | null>(null)
const addOpen = computed({
  get: () => addTarget.value !== null,
  set: (v: boolean) => { if (!v) addTarget.value = null },
})
const addTargetIds = computed(() => (addTarget.value === null ? [] : [addTarget.value]))

function onAdded() {
  addTarget.value = null
  emit('collection-changed')
  void load(props.documentId)
}
</script>

<template>
  <section class="related-card" aria-labelledby="related-title">
    <div class="related-header">
      <h2 id="related-title" class="related-title"><i class="pi pi-sitemap" /> Verwandte Dokumente</h2>
      <span v-if="!loading && total > 0" class="related-count">{{ total }}</span>
    </div>

    <p v-if="loading" class="related-empty">Wird gesucht …</p>
    <p v-else-if="failed" class="related-empty">Verwandte Dokumente konnten nicht geladen werden.</p>
    <p v-else-if="groups.length === 0" class="related-empty">
      Nichts gefunden: kein anderes Dokument aus demselben Ordner, vom selben Absender in
      zeitlicher Nähe, aus einer gemeinsamen Sammelmappe oder mit ähnlichem Inhalt.
    </p>

    <div v-else class="related-groups">
      <div v-for="g in groups" :key="`${g.reason}:${g.label ?? ''}`" class="related-group">
        <h3 class="related-group__title">
          <i :class="REASON_ICONS[g.reason]" aria-hidden="true" />
          <button
            v-if="g.reason === 'same_collection'"
            type="button"
            class="related-group__link"
            :title="`Sammelmappe „${g.label}“ öffnen`"
            @click="openCollection(g)"
          >{{ groupTitle(g) }}</button>
          <span v-else>{{ groupTitle(g) }}</span>
        </h3>
        <ul class="related-list">
          <li v-for="item in g.items" :key="item.id" class="related-item">
            <button
              type="button"
              class="related-item__main"
              :title="item.title || item.original_filename"
              @click="open(item)"
            >
              <DocumentThumbnail :id="item.id" :alt="item.title || item.original_filename" />
              <span class="related-item__text">
                <span class="related-item__title">{{ item.title || item.original_filename }}</span>
                <span class="related-item__meta">
                  <span v-if="item.doc_date">{{ formatDocDate(item.doc_date) }}</span>
                  <span v-if="item.correspondent_display || item.sender">{{ item.correspondent_display || item.sender }}</span>
                  <span v-if="item.semantic_distance != null" class="related-item__distance">
                    Ähnlichkeit {{ Math.round((1 - item.semantic_distance) * 100) }}%
                  </span>
                </span>
              </span>
            </button>
            <Button
              icon="pi pi-folder-plus"
              text
              rounded
              size="small"
              aria-label="In Sammelmappe legen"
              v-tooltip.left="'In Sammelmappe legen'"
              @click="addTarget = item.id"
            />
          </li>
        </ul>
      </div>
    </div>

    <AddToCollectionDialog
      v-model:visible="addOpen"
      :document-ids="addTargetIds"
      @added="onAdded"
    />
  </section>
</template>

<style scoped>
.related-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0.85rem 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
}
.related-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.related-title {
  font-size: var(--text-lg);
  font-weight: 600;
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.related-count {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.related-empty {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
}
.related-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.related-group__title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--p-text-muted-color);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.related-group__link {
  all: unset;
  cursor: pointer;
  color: var(--p-primary-color);
}
.related-group__link:hover {
  text-decoration: underline;
}
.related-group__link:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.related-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.related-item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  /* Room for the focus ring of the row button inside the clipped card. */
  padding: var(--focus-ring-reach);
  margin: calc(-1 * var(--focus-ring-reach));
}
.related-item__main {
  all: unset;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0.3rem 0.4rem;
  border-radius: 6px;
  cursor: pointer;
}
.related-item__main:hover {
  background: var(--p-content-hover-background);
}
.related-item__main:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.related-item__main :deep(.doc-thumb) {
  width: 2.5rem;
  height: 3.25rem;
  flex: none;
}
.related-item__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.related-item__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--p-text-color);
}
.related-item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--space-2);
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
</style>
