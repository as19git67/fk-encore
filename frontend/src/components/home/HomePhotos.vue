<script setup lang="ts">
/**
 * The photos of one thing in the house handbook — a system, an item or a
 * note (documentation/plans/haus-anlagen.md, stage 2): small pictures in a
 * row, a tap opens the photo with its caption, "Foto" adds one or several.
 * On a phone the file picker offers the camera directly.
 */
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { useConfirm } from 'primevue/useconfirm'
import {
  deleteHomeMedia,
  homeMediaUrl,
  updateHomeMediaCaption,
  uploadHomeMedia,
  type HomeMedia,
  type HomeMediaTargetKind,
} from '../../api/home'

const props = defineProps<{
  systemId: number
  target: { kind: HomeMediaTargetKind; id: number }
  photos: HomeMedia[]
  canWrite: boolean
  /** What the photos show, for the labels: "der Notiz vom 03.05.2026". */
  subject: string
  /** Small pictures for a table row. */
  compact?: boolean
}>()
const emit = defineEmits<{ changed: [] }>()

const confirm = useConfirm()
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const error = ref('')

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (files.length === 0) return
  uploading.value = true
  error.value = ''
  let failed = 0
  for (const file of files) {
    try {
      await uploadHomeMedia(props.systemId, props.target, file)
    } catch (err: any) {
      failed += 1
      error.value = err?.message ?? 'Das Foto konnte nicht hochgeladen werden.'
    }
  }
  if (failed > 1) error.value = `${failed} Fotos konnten nicht hochgeladen werden. ${error.value}`
  uploading.value = false
  emit('changed')
}

const shown = ref<HomeMedia | null>(null)
const caption = ref('')
const saving = ref(false)
const viewerError = ref('')

const viewerOpen = computed({
  get: () => shown.value !== null,
  set: (open: boolean) => { if (!open) shown.value = null },
})

function open(photo: HomeMedia) {
  shown.value = photo
  caption.value = photo.caption ?? ''
  viewerError.value = ''
}

function step(direction: -1 | 1) {
  const index = props.photos.findIndex((p) => p.id === shown.value?.id)
  const next = props.photos[index + direction]
  if (next) open(next)
}

const position = computed(() => {
  const index = props.photos.findIndex((p) => p.id === shown.value?.id)
  return { index, count: props.photos.length }
})

async function saveCaption() {
  const photo = shown.value
  if (!photo || saving.value) return
  saving.value = true
  viewerError.value = ''
  try {
    await updateHomeMediaCaption(photo.id, caption.value.trim() || null)
    shown.value = null
    emit('changed')
  } catch (err: any) {
    viewerError.value = err?.message ?? 'Die Beschriftung konnte nicht gespeichert werden.'
  } finally {
    saving.value = false
  }
}

function confirmDelete() {
  const photo = shown.value
  if (!photo) return
  confirm.require({
    header: 'Foto löschen',
    message: photo.caption ? `Foto „${photo.caption}“ löschen?` : `Dieses Foto ${props.subject} löschen?`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteHomeMedia(photo.id)
        shown.value = null
        emit('changed')
      } catch (err: any) {
        viewerError.value = err?.message ?? 'Löschen fehlgeschlagen.'
      }
    },
  })
}
</script>

<template>
  <div class="hp" :class="{ 'hp--compact': compact }">
    <ul v-if="photos.length" class="hp-list" :aria-label="`Fotos ${subject}`">
      <li v-for="(p, i) in photos" :key="p.id">
        <button
          type="button"
          class="hp-thumb"
          :aria-label="p.caption ? `Foto öffnen: ${p.caption}` : `Foto ${i + 1} öffnen`"
          @click="open(p)"
        >
          <img :src="homeMediaUrl(p.id, 'small')" alt="" loading="lazy" />
        </button>
      </li>
    </ul>
    <template v-if="canWrite">
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        class="hp-input"
        tabindex="-1"
        aria-hidden="true"
        @change="onFiles"
      />
      <Button
        :label="compact ? undefined : 'Foto'"
        icon="pi pi-camera"
        :text="compact"
        :rounded="compact"
        severity="secondary"
        size="small"
        :loading="uploading"
        :aria-label="`Foto ${subject} hinzufügen`"
        v-tooltip.bottom="compact ? 'Foto hinzufügen' : undefined"
        @click="fileInput?.click()"
      />
    </template>
    <Message v-if="error" severity="error" closable class="hp-error" @close="error = ''">{{ error }}</Message>

    <Dialog
      v-model:visible="viewerOpen"
      class="dialog-lg"
      modal
      :header="position.count > 1 ? `Foto ${position.index + 1} von ${position.count}` : 'Foto'"
    >
      <div v-if="shown" class="hp-viewer">
        <Message v-if="viewerError" severity="error" :closable="false">{{ viewerError }}</Message>
        <img :src="homeMediaUrl(shown.id, 'full')" :alt="shown.caption ?? ''" class="hp-full" />
        <div v-if="position.count > 1" class="hp-steps">
          <Button icon="pi pi-chevron-left" text rounded severity="secondary" aria-label="Voriges Foto" :disabled="position.index === 0" @click="step(-1)" />
          <Button icon="pi pi-chevron-right" text rounded severity="secondary" aria-label="Nächstes Foto" :disabled="position.index === position.count - 1" @click="step(1)" />
        </div>
        <template v-if="canWrite">
          <label :for="`hp-caption-${shown.id}`" class="hp-label">Beschriftung</label>
          <InputText
            :id="`hp-caption-${shown.id}`"
            v-model="caption"
            placeholder="z. B. Lage des Absperrventils"
            @keydown.enter.prevent="saveCaption"
          />
        </template>
        <p v-else-if="shown.caption" class="hp-caption">{{ shown.caption }}</p>
      </div>
      <template #footer>
        <Button v-if="canWrite" label="Löschen" icon="pi pi-trash" text severity="danger" @click="confirmDelete" />
        <span class="hp-spacer" />
        <Button :label="canWrite ? 'Abbrechen' : 'Schließen'" text severity="secondary" @click="shown = null" />
        <Button v-if="canWrite" label="Speichern" icon="pi pi-check" :loading="saving" @click="saveCaption" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.hp {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.hp--compact {
  flex-wrap: nowrap;
  gap: var(--space-1);
}
.hp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.hp--compact .hp-list {
  flex-wrap: nowrap;
  gap: var(--space-1);
}
.hp-thumb {
  display: block;
  padding: 0;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  background: var(--p-content-hover-background);
  cursor: pointer;
  overflow: hidden;
  width: 4.5rem;
  height: 4.5rem;
}
.hp--compact .hp-thumb {
  width: 2.5rem;
  height: 2.5rem;
}
.hp-thumb:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.hp-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hp-input {
  display: none;
}
.hp-error {
  flex-basis: 100%;
}
.hp-viewer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.hp-full {
  display: block;
  max-width: 100%;
  max-height: 65dvh;
  margin: 0 auto;
  border-radius: 6px;
}
.hp-steps {
  display: flex;
  justify-content: center;
  gap: var(--space-2);
}
.hp-label {
  font-size: var(--text-md);
  color: var(--p-text-muted-color);
}
.hp-caption {
  margin: 0;
  text-align: center;
}
.hp-spacer {
  flex: 1 1 auto;
}
</style>
