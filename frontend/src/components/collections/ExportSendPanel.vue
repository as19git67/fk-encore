<script setup lang="ts">
/**
 * Passing a finished export on (#1548, stage 7), shown under a run in the
 * export dialog.
 *
 * - "Teilen" hands the file to the device's share sheet — every messenger
 *   and mail app installed, sent as the user. Up to ten items can go as
 *   single files instead of the ZIP. iOS only shares a file that is already
 *   fetched when the tap happens, so the panel fetches it as soon as it
 *   opens (up to PREFETCH_LIMIT) and "Teilen" then shares on the first tap.
 * - "Per E-Mail" sends from the server, from the app's address or — where
 *   the user's shares its domain — the user's (ExportSenderField); above the
 *   size limit the mail carries a download link.
 * - "Link kopieren" gives a download link for people without an account,
 *   valid as long as the file.
 */
import { computed, onMounted, ref, watch } from 'vue'
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
import ExportSenderField from './ExportSenderField.vue'

const props = defineProps<{
  run: ExportRun
  /** False when the server cannot send mail; the mail form then explains. */
  mailConfigured: boolean
  /** The user's address. */
  senderEmail?: string | null
  /** The app's address, the sender by default. */
  systemSender?: string
  /** The user's address shares the app's domain and may be chosen instead. */
  selfSenderAllowed?: boolean
  /** Show "Speichern" as the first of the ways on (emits `download`). */
  downloadable?: boolean
  /** The download is under way. */
  downloading?: boolean
}>()

/** Fetched ahead for the share sheet up to this size; above it, on request. */
const PREFETCH_LIMIT = 40 * 1024 * 1024
const emit = defineEmits<{ (e: 'sent'): void; (e: 'download'): void }>()

const entries = ref<ExportEntry[]>([])
const singleAllowed = ref(false)
const singleFiles = ref(false)
const prepared = ref<File[] | null>(null)
const preparing = ref(false)
const error = ref('')
const info = ref('')
const mailOpen = ref(false)
const recipients = ref('')
const message = ref('')
const sending = ref(false)
const fromSelf = ref(false)

const isZip = computed(() => props.run.mime_type === 'application/zip')
const shareable = canShareFiles()

onMounted(async () => {
  if (isZip.value) {
    try {
      const res = await listExportEntries(props.run.id)
      entries.value = res.items
      singleAllowed.value = res.single_files_allowed && res.items.length > 1
    } catch {
      /* single files are an extra; the ZIP still goes */
    }
  }
  if (shareable && (props.run.size_bytes ?? 0) <= PREFETCH_LIMIT) void prepare()
})

// Single files or the ZIP: what was fetched no longer fits.
watch(singleFiles, () => {
  prepared.value = null
  if (shareable && (props.run.size_bytes ?? 0) <= PREFETCH_LIMIT) void prepare()
})

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
  if (!prepared.value) {
    // Too large to fetch ahead: fetch now, the next tap shares.
    void prepare()
    return
  }
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
    const res = await sendExportByMail(
      props.run.id,
      recipientList.value,
      message.value.trim() || null,
      singleFiles.value,
      fromSelf.value && props.selfSenderAllowed === true,
    )
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
    <!-- The ways on, side by side and alike: none is the main one. -->
    <div class="send-actions" role="group" aria-label="Weitergeben">
      <Button
        v-if="downloadable"
        icon="pi pi-download"
        icon-pos="top"
        label="Speichern"
        size="small"
        outlined
        class="send-action"
        :loading="downloading"
        data-testid="export-result-download"
        @click="emit('download')"
      />
      <Button
        v-if="shareable"
        icon="pi pi-share-alt"
        icon-pos="top"
        :label="prepared || preparing || (run.size_bytes ?? 0) <= PREFETCH_LIMIT ? 'Teilen' : 'Zum Teilen laden'"
        size="small"
        outlined
        class="send-action"
        :loading="preparing"
        data-testid="export-share-now"
        @click="share"
      />
      <Button
        icon="pi pi-envelope"
        icon-pos="top"
        label="E-Mail"
        size="small"
        :outlined="!mailOpen"
        class="send-action"
        :aria-expanded="mailOpen"
        data-testid="export-mail-toggle"
        @click="mailOpen = !mailOpen"
      />
      <Button
        icon="pi pi-link"
        icon-pos="top"
        label="Link kopieren"
        size="small"
        outlined
        class="send-action"
        @click="copyLink"
      />
    </div>
    <p v-if="!shareable" class="send-hint">
      An andere Apps teilen geht in diesem Browser nicht, auf dem Smartphone schon.
    </p>

    <Message v-if="error" severity="error" :closable="true" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" :closable="true" @close="info = ''">{{ info }}</Message>

    <label v-if="singleAllowed" class="send-check">
      <Checkbox v-model="singleFiles" binary />
      <span>Einzeln statt als ZIP teilen oder mailen ({{ entries.length }} Dateien)</span>
    </label>

    <div v-if="mailOpen" class="send-body">
      <p v-if="!mailConfigured" class="send-hint">
        Der E-Mail-Versand ist auf diesem Server nicht eingerichtet. Teilen oder den Link weitergeben geht trotzdem.
      </p>
      <template v-else>
        <ExportSenderField
          v-model="fromSelf"
          :sender-email="senderEmail ?? null"
          :system-sender="systemSender ?? ''"
          :allowed="selfSenderAllowed === true"
          :input-id="`send-self-${run.id}`"
        />
        <label class="send-label" :for="`send-to-${run.id}`">An (mehrere mit Komma)</label>
        <InputText :id="`send-to-${run.id}`" v-model="recipients" placeholder="name@beispiel.de" class="send-field" />
        <label class="send-label" :for="`send-msg-${run.id}`">Nachricht (optional)</label>
        <Textarea :id="`send-msg-${run.id}`" v-model="message" rows="3" auto-resize class="send-field" />
        <p class="send-hint">Große Dateien gehen als Link, der bis zum Ablauf des Exports gilt.</p>
        <Button
          icon="pi pi-send"
          label="Senden"
          size="small"
          :loading="sending"
          :disabled="recipientList.length === 0"
          data-testid="export-mail-send"
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
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: var(--space-2);
}
.send-action {
  min-width: 0;
  white-space: normal;
  text-align: center;
  /* Icons on one line, however many lines a label takes. */
  justify-content: flex-start;
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
