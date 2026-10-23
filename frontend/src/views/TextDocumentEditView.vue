<script setup lang="ts">
/**
 * Writes a new text document or edits one (`/dokumente/neu`,
 * `/dokumente/:id/bearbeiten`). The text is Markdown; on save the server
 * renders the PDF from it and runs the document through the usual pipeline,
 * so it turns up in list, search and collections like any upload.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import PageLayout from '../components/layout/PageLayout.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import MarkdownEditor from '../components/documents/MarkdownEditor.vue'
import ComposeDialog from '../components/documents/ComposeDialog.vue'
import { useAuthStore } from '../stores/auth'
import { TEXT_DRAFT_STATE_KEY, type TextDraft } from '../utils/markdown'
import type { InsertPlace } from '../utils/markdown'
import { useModuleBack } from '../composables/useModuleBack'
import { ApiError } from '../api/client'
import { createTextDocument, getDocument, updateTextDocument } from '../api/documents'

const route = useRoute()
const router = useRouter()
const confirm = useConfirm()
const auth = useAuthStore()
const editor = ref<InstanceType<typeof MarkdownEditor> | null>(null)
const composeOpen = ref(false)

function onComposed(text: string, where: InsertPlace) {
  editor.value?.insertText(text, where)
}

/** A text handed over from elsewhere ("Als Dokument speichern" in the chat) opens as the draft. */
function takeDraft() {
  const draft = (window.history.state as Record<string, unknown> | null)?.[TEXT_DRAFT_STATE_KEY] as TextDraft | undefined
  if (!draft) return
  title.value = draft.title ?? ''
  markdown.value = draft.markdown ?? ''
}
const { goBack } = useModuleBack('/dokumente', 'dokumente-list')

const docId = computed(() => (route.params.id ? Number(route.params.id) : null))
const isNew = computed(() => docId.value == null)

const title = ref('')
const markdown = ref('')
const revision = ref<string | undefined>(undefined)
const saved = ref({ title: '', markdown: '' })
const loading = ref(false)
const loadError = ref('')
const saveError = ref('')
const saving = ref(false)

const dirty = computed(() => title.value !== saved.value.title || markdown.value !== saved.value.markdown)
const canSave = computed(() => title.value.trim().length > 0 && !saving.value && (isNew.value || dirty.value))

async function load() {
  if (docId.value == null) return
  loading.value = true
  loadError.value = ''
  try {
    const doc = await getDocument(docId.value)
    if (doc.markdown_source == null) {
      loadError.value = 'Dieses Dokument wurde hochgeladen und lässt sich nicht als Text bearbeiten.'
      return
    }
    title.value = doc.title ?? ''
    markdown.value = doc.markdown_source
    revision.value = doc.content_revision
    saved.value = { title: title.value, markdown: markdown.value }
  } catch (err) {
    loadError.value = (err as Error).message || 'Dokument kann nicht geladen werden'
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!canSave.value) return
  saving.value = true
  saveError.value = ''
  try {
    const payload = { title: title.value, markdown: markdown.value }
    const doc = docId.value == null
      ? await createTextDocument(payload)
      : await updateTextDocument(docId.value, { ...payload, base_revision: revision.value })
    // What the server stored (trimmed), so leaving does not ask again.
    saved.value = { title: title.value, markdown: markdown.value }
    await router.replace({ name: 'dokumente-detail', params: { id: doc.id } })
  } catch (err) {
    saveError.value = err instanceof ApiError && err.code === 'aborted'
      ? 'Jemand hat dieses Dokument inzwischen gespeichert. Kopiere deinen Text, lade die Seite neu und füge deine Änderungen wieder ein.'
      : (err as Error).message || 'Speichern fehlgeschlagen'
  } finally {
    saving.value = false
  }
}

onBeforeRouteLeave(() => {
  if (!dirty.value || saving.value) return true
  return new Promise<boolean>((resolve) => {
    confirm.require({
      header: 'Änderungen verwerfen?',
      message: 'Der Text ist noch nicht gespeichert. Beim Verlassen geht er verloren.',
      icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Weiter schreiben',
      acceptLabel: 'Verwerfen',
      acceptClass: 'p-button-danger',
      accept: () => resolve(true),
      reject: () => resolve(false),
      onHide: () => resolve(false),
    })
  })
})

function onBeforeUnload(ev: BeforeUnloadEvent) {
  if (!dirty.value) return
  ev.preventDefault()
}

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  if (isNew.value) takeDraft()
  void load()
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

const PLACEHOLDER = `## Überschrift

Ein Absatz mit **fettem** und *kursivem* Text.

- ein Punkt
- noch ein Punkt`
</script>

<template>
  <PageLayout
    :title="isNew ? 'Neues Textdokument' : 'Text bearbeiten'"
    hint="Formatiert wird mit Markdown. Beim Speichern entsteht daraus ein PDF mit dem heutigen Datum und dir als Absender, das wie jedes andere Dokument eingeordnet wird."
    :ready="!loading"
    sticky-header
  >
    <template #back>
      <Button icon="pi pi-arrow-left" text rounded aria-label="Zurück" @click="goBack" />
    </template>

    <template #actions>
      <Button
        v-if="auth.hasPermission('module.assistant')"
        icon="pi pi-sparkles"
        label="Assistent"
        text
        :disabled="loading || !!loadError"
        aria-label="Assistent schreiben lassen"
        v-tooltip.bottom="'Text vom Assistenten schreiben lassen'"
        @click="composeOpen = true"
      />
      <Button label="Abbrechen" severity="secondary" text @click="goBack" />
      <Button
        label="Speichern"
        icon="pi pi-check"
        :loading="saving"
        :disabled="!canSave"
        @click="save"
      />
    </template>

    <template #notice>
      <ErrorBanner v-if="loadError" :message="loadError" @retry="load" />
      <Message v-if="saveError" severity="error" @close="saveError = ''">{{ saveError }}</Message>
    </template>

    <PageSkeleton v-if="loading" />
    <div v-else-if="!loadError" class="text-doc">
      <label class="text-doc__title">
        <span>Titel</span>
        <InputText v-model="title" maxlength="200" placeholder="z. B. Notizen zur Heizungswartung" fluid />
      </label>
      <MarkdownEditor
        ref="editor"
        v-model="markdown"
        :placeholder="PLACEHOLDER"
        aria-label="Text des Dokuments in Markdown"
        @save="save"
      />
    </div>

    <ComposeDialog
      v-if="auth.hasPermission('module.assistant')"
      v-model:visible="composeOpen"
      :title="title"
      :current-text="markdown"
      @insert="onComposed"
    />
  </PageLayout>
</template>

<style scoped>
.text-doc {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.text-doc__title {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-weight: 600;
}
</style>
