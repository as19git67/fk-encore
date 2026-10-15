<script setup lang="ts">
/**
 * Passing a finished export on (#1548, stage 7), shown under a run in the
 * export dialog.
 *
 * - "Teilen" hands the file to the device's share sheet — every messenger
 *   and mail app installed, sent as the user. Up to ten items can go as
 *   single files instead of the ZIP. iOS only shares a file that is already
 *   fetched when the tap happens, so the files are fetched first and the
 *   button then shares at once.
 * - "Per E-Mail" sends from the server, with replies going to the user;
 *   above the size limit the mail carries a download link instead.
 * - "Link kopieren" gives a download link for people without an account,
 *   valid as long as the file.
 */
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Textarea from 'primevue/textarea'
import {
  createExportLink,
  fetchCollectionExportFile,
  fetchExportEntryFile,
  listExportEntries,
  sendExportByMail,
  type ExportEntry,
  type ExportRun,
} from '../../api/collections'
import { canShareFiles, shareFiles } from '../../utils/shareFile'

const props = defineProps<{
  run: ExportRun
  /** False when the server cannot send mail; the mail form then explains. */
  mailConfigured: boolean
}>()
const emit = defineEmits<{ (e: 'sent'): void }>()

const entries = ref<ExportEntry[]>([])
const singleAllowed = ref(false)
const singleFiles = ref(false)
const prepared = ref<File[] | null>(null)
const preparing = ref(false)
const error = ref('')
const info = ref('')
const mode = ref<'share' | 'mail' | null>(null)
const recipients = ref('')
const message = ref('')
const sending = ref(false)

const isZip = computed(() => props.run.mime_type === 'application/zip')
const shareable = canShareFiles()

onMounted(async () => {
  if (!isZip.value) return
  try {
    const res = await listExportEntries(props.run.id)
    entries.value = res.items
    singleAllowed.value = res.single_files_allowed && res.items.length > 1
  } catch {
    /* single files are an extra; the ZIP still goes */
  }
})

function reset() {
  prepared.value = null
  error.value = ''
  info.value = ''
}

async function prepare() {
  preparing.value = true
  error.value = ''
  try {
    prepared.value =
      singleFiles.value && isZip.value
        ? await Promise.all(entries.value.map((e) => fetchExportEntryFile(props.run.id, e.name)))
        : [await fetchCollectionExportFile(props.run)]
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Datei konnte nicht geladen werden.'
  } finally {
    preparing.value = false
  }
}

/** Straight from the click: nothing awaited before the share call. */
function share() {
  if (!prepared.value) return
  shareFiles(prepared.value, props.run.filename ?? 'Export')
    .then((shared) => {
      if (!shared) error.value = 'Dieses Gerät kann die Dateien nicht teilen. Lade sie stattdessen herunter.'
    })
    .catch((err: unknown) => {
      error.value = err instanceof Error ? err.message : 'Teilen fehlgeschlagen.'
    })
}

async function copyLink() {
  error.value = ''
  try {
    const link = await createExportLink(props.run.id)
    await navigator.clipboard.writeText(link.url)
    const until = new Date(link.expires_at).toLocaleDateString('de-DE')
    info.value = `Link kopiert. Wer ihn hat, kann die Datei bis ${until} herunterladen.`
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Link konnte nicht erstellt werden.'
  }
}

const recipientList = computed(() =>
  recipients.value
    .split(/[\s,;]+/)
    .map((r) => r.trim())
    .filter(Boolean),
)

async function send() {
  if (recipientList.value.length === 0) return
  sending.value = true
  error.value = ''
  info.value = ''
  try {
    const res = await sendExportByMail(props.run.id, recipientList.value, message.value.trim() || null, singleFiles.value)
    info.value =
      res.mode === 'link'
        ? 'Gesendet, mit Download-Link: Die Datei ist zu groß für einen Anhang.'
        : res.mode === 'items'
          ? 'Gesendet, die Dateien einzeln angehängt.'
          : 'Gesendet.'
    recipients.value = ''
    message.value = ''
    emit('sent')
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Senden fehlgeschlagen.'
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="send" data-testid="export-send">
    <div class="send-actions">
      <Button
        icon="pi pi-share-alt"
        label="Teilen"
        size="small"
        :outlined="mode !== 'share'"
        :aria-expanded="mode === 'share'"
        @click="mode = mode === 'share' ? null : 'share'; reset()"
      />
      <Button
        icon="pi pi-envelope"
        label="Per E-Mail"
        size="small"
        :outlined="mode !== 'mail'"
        :aria-expanded="mode === 'mail'"
        @click="mode = mode === 'mail' ? null : 'mail'; reset()"
      />
      <Button icon="pi pi-link" label="Link kopieren" size="small" text @click="copyLink" />
    </div>

    <Message v-if="error" severity="error" :closable="true" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" :closable="true" @close="info = ''">{{ info }}</Message>

    <label v-if="mode && singleAllowed" class="send-check">
      <Checkbox v-model="singleFiles" binary @update:model-value="prepared = null" />
      <span>Einzeln statt als ZIP ({{ entries.length }} Dateien)</span>
    </label>

    <div v-if="mode === 'share'" class="send-body">
      <p v-if="!shareable" class="send-hint">
        Dieser Browser kann keine Dateien an andere Apps geben. Auf dem Smartphone öffnet „Teilen“ das Teilen-Menü;
        hier bleibt der Download oder der Link.
      </p>
      <template v-else>
        <Button
          v-if="!prepared"
          icon="pi pi-cloud-download"
          :label="singleFiles ? 'Dateien vorbereiten' : 'Datei vorbereiten'"
          size="small"
          :loading="preparing"
          @click="prepare"
        />
        <Button v-else icon="pi pi-share-alt" label="Jetzt teilen" size="small" data-testid="export-share-now" @click="share" />
      </template>
    </div>

    <div v-if="mode === 'mail'" class="send-body">
      <p v-if="!mailConfigured" class="send-hint">
        Der E-Mail-Versand ist auf diesem Server nicht eingerichtet. Teilen oder den Link weitergeben geht trotzdem.
      </p>
      <template v-else>
        <label class="send-label" :for="`send-to-${run.id}`">An (mehrere mit Komma)</label>
        <InputText :id="`send-to-${run.id}`" v-model="recipients" placeholder="name@beispiel.de" class="send-field" />
        <label class="send-label" :for="`send-msg-${run.id}`">Nachricht (optional)</label>
        <Textarea :id="`send-msg-${run.id}`" v-model="message" rows="3" auto-resize class="send-field" />
        <p class="send-hint">Absender ist die App, Antworten gehen an dich. Große Dateien gehen als Link, der bis zum Ablauf des Exports gilt.</p>
        <Button
          icon="pi pi-send"
          label="Senden"
          size="small"
          :loading="sending"
          :disabled="recipientList.length === 0"
          @click="send"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.send {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) 0 0;
}
.send-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.send-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.send-label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.send-field {
  width: 100%;
}
.send-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.send-hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
</style>
