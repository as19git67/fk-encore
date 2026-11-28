<script setup lang="ts">
/**
 * One spare part: what it is, where it lies, how many are left, which
 * systems it fits and which items take it, with photos
 * (documentation/plans/haus-anlagen.md, stage 3).
 *
 * Everybody who sees the part and has `home.manage` edits it and counts the
 * stock ("−1" when one is used); sharing and deleting stay with its owner
 * and the owners of its group (`canManage`).
 */
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import Menu from 'primevue/menu'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import { useConfirm } from 'primevue/useconfirm'
import type { MenuItem } from 'primevue/menuitem'
import PageLayout from '../components/layout/PageLayout.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import HomePartDialog from '../components/home/HomePartDialog.vue'
import HomePhotos from '../components/home/HomePhotos.vue'
import { useModuleBack } from '../composables/useModuleBack'
import { useAuthStore } from '../stores/auth'
import {
  adjustHomePartStock,
  deleteHomePart,
  getHomePart,
  stockLabel,
  type HomePartDetail,
} from '../api/home'

const route = useRoute()
const auth = useAuthStore()
const confirm = useConfirm()
const { goBack } = useModuleBack('/haus', 'haus-ersatzteile')

const partId = computed(() => Number(route.params.id))
const part = ref<HomePartDetail | null>(null)
const loading = ref(true)
const loadError = ref('')
const error = ref('')

const canWrite = computed(() => auth.hasPermission('home.manage'))
const canManage = computed(() => canWrite.value && !!part.value?.canManage)

async function load() {
  loadError.value = ''
  try {
    part.value = await getHomePart(partId.value)
  } catch (err: any) {
    loadError.value = err?.message ?? 'Das Ersatzteil konnte nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

watch(partId, () => {
  loading.value = true
  part.value = null
  void load()
}, { immediate: true })

const sharingLabel = computed(() => {
  const p = part.value
  if (!p) return ''
  const owner = p.ownerUserId === auth.user?.id ? '' : ` · von ${p.ownerName}`
  if (p.groupId === null) return `Privat${owner}`
  return `${p.household ? 'Haushalt' : 'Gruppe'} „${p.groupName ?? ''}“${owner}`
})

const facts = computed(() => {
  const p = part.value
  if (!p) return []
  return [
    { label: 'Hersteller', value: p.manufacturer },
    { label: 'Teilenummer', value: p.partNumber },
    { label: 'EAN', value: p.ean },
    { label: 'Maße', value: p.specification },
    { label: 'Lagerort', value: p.storageLocation },
    { label: 'Geteilt', value: sharingLabel.value },
  ].filter((f) => f.value)
})

/** Shown as a link only when it is a web address (the server checks too). */
const supplierHost = computed(() => {
  const url = part.value?.supplierUrl
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
})

const stockBusy = ref(false)

async function changeStock(delta: number) {
  const p = part.value
  if (!p || stockBusy.value) return
  stockBusy.value = true
  error.value = ''
  try {
    p.stock = (await adjustHomePartStock(p.id, delta)).stock
  } catch (err: any) {
    error.value = err?.message ?? 'Der Bestand konnte nicht geändert werden.'
    await load()
  } finally {
    stockBusy.value = false
  }
}

const editOpen = ref(false)
const moreMenu = ref<InstanceType<typeof Menu> | null>(null)

const moreItems = computed<MenuItem[]>(() => [
  { label: 'Löschen …', icon: 'pi pi-trash', class: 'danger-item', command: confirmDelete },
])

async function onEdited() {
  editOpen.value = false
  await load()
}

function confirmDelete() {
  const p = part.value
  if (!p) return
  const uses = p.systems.length
    ? ` Es wird bei ${p.systems.length} Anlage(n) und ${p.items.length} Einzelteil(en) ausgetragen.`
    : ''
  confirm.require({
    header: 'Ersatzteil löschen',
    message: `„${p.name}“ mit ${p.media.length} Foto(s) löschen?${uses} Das lässt sich nicht rückgängig machen.`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Endgültig löschen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteHomePart(p.id)
        goBack()
      } catch (err: any) {
        error.value = err?.message ?? 'Löschen fehlgeschlagen.'
      }
    },
  })
}
</script>

<template>
  <PageLayout :title="part?.name ?? 'Ersatzteil'" width="normal" :ready="!loading" sticky-header>
    <template #back>
      <Button icon="pi pi-arrow-left" text rounded aria-label="Zurück" @click="goBack" />
    </template>

    <template #actions>
      <Button v-if="part && canWrite" label="Bearbeiten" icon="pi pi-pencil" severity="secondary" size="small" @click="editOpen = true" />
    </template>

    <template #menu>
      <template v-if="canManage && part">
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
    </template>

    <PageSkeleton v-if="loading" variant="list" :count="3" />

    <div v-else-if="part" class="pd-page">
      <section class="pd-card" aria-labelledby="pd-stock">
        <h2 id="pd-stock" class="pd-heading">Bestand</h2>
        <div class="pd-stock">
          <Tag v-if="part.stock === 0" severity="warn" icon="pi pi-exclamation-circle" :value="stockLabel(part.stock)" />
          <span v-else class="pd-stock-value">{{ stockLabel(part.stock) }}</span>
          <template v-if="canWrite && part.stock !== null">
            <Button
              label="1 entnommen"
              icon="pi pi-minus"
              severity="secondary"
              size="small"
              :disabled="part.stock === 0"
              :loading="stockBusy"
              @click="changeStock(-1)"
            />
            <Button
              icon="pi pi-plus"
              severity="secondary"
              size="small"
              text
              rounded
              aria-label="Eins dazu"
              v-tooltip.bottom="'Eins dazu'"
              :disabled="stockBusy"
              @click="changeStock(1)"
            />
          </template>
        </div>
        <p v-if="part.storageLocation" class="pd-where">
          <i class="pi pi-map-marker" aria-hidden="true" /> {{ part.storageLocation }}
        </p>
        <p v-if="part.stock === null" class="pd-muted">
          Der Bestand wird nicht gezählt. Unter „Bearbeiten“ lässt sich eine Zahl eintragen.
        </p>
      </section>

      <section class="pd-card" aria-labelledby="pd-facts">
        <h2 id="pd-facts" class="pd-heading">Steckbrief</h2>
        <dl v-if="facts.length" class="pd-facts">
          <template v-for="f in facts" :key="f.label">
            <dt>{{ f.label }}</dt>
            <dd>{{ f.value }}</dd>
          </template>
          <template v-if="supplierHost">
            <dt>Bezugsquelle</dt>
            <dd>
              <a :href="part.supplierUrl!" target="_blank" rel="noopener noreferrer">
                {{ supplierHost }} <i class="pi pi-external-link" aria-hidden="true" />
              </a>
            </dd>
          </template>
        </dl>
        <p v-if="part.notes" class="pd-notes">{{ part.notes }}</p>
        <HomePhotos
          :system-id="null"
          :target="{ kind: 'part', id: part.id }"
          :photos="part.media"
          :can-write="canWrite"
          subject="des Ersatzteils"
          class="pd-photos"
          @changed="load"
        />
      </section>

      <section class="pd-card" aria-labelledby="pd-uses">
        <h2 id="pd-uses" class="pd-heading">Passt zu</h2>
        <p v-if="part.systems.length === 0" class="pd-muted">
          Noch keiner Anlage zugeordnet. Das geht auf der Seite der Anlage unter „Ersatzteile“.
        </p>
        <ul v-else class="pd-links">
          <li v-for="s in part.systems" :key="s.id">
            <RouterLink :to="{ name: 'haus-anlage', params: { id: s.id } }">{{ s.name }}</RouterLink>
          </li>
        </ul>
        <template v-if="part.items.length">
          <h3 class="pd-subheading">Eingebaut bei</h3>
          <ul class="pd-links">
            <li v-for="i in part.items" :key="i.itemId">
              <RouterLink :to="{ name: 'haus-anlage', params: { id: i.systemId } }">{{ i.systemName }}</RouterLink>
              · {{ i.label }}<template v-if="i.location"> ({{ i.location }})</template>
            </li>
          </ul>
        </template>
      </section>
    </div>

    <HomePartDialog v-if="editOpen && part" v-model:visible="editOpen" :part="part" @saved="onEdited" />
  </PageLayout>
</template>

<style scoped>
.pd-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.pd-card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  background: var(--p-content-background);
  padding: var(--space-3) var(--space-4);
  min-width: 0;
}
.pd-heading {
  font-size: var(--text-xl);
  margin: 0 0 var(--space-2);
}
.pd-subheading {
  font-size: var(--text-lg);
  margin: var(--space-3) 0 var(--space-1);
}
.pd-stock {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.pd-stock-value {
  font-size: var(--text-lg);
  font-weight: 600;
}
.pd-where {
  margin: var(--space-2) 0 0;
  overflow-wrap: anywhere;
}
.pd-muted {
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
  margin: var(--space-2) 0 0;
}
.pd-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-1) var(--space-3);
  margin: 0 0 var(--space-3);
}
.pd-facts dt {
  color: var(--p-text-muted-color);
}
.pd-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.pd-notes {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0 0 var(--space-2);
}
.pd-photos {
  margin-top: var(--space-2);
}
.pd-links {
  margin: 0;
  padding-left: 1.2rem;
}
.pd-links li {
  overflow-wrap: anywhere;
}
</style>
