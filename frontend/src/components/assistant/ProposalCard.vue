<script setup lang="ts">
/**
 * A write action the assistant proposed (#1529). Nothing has happened yet:
 * "Ausführen" runs it as the user, through the same endpoints the app's own
 * buttons use; "Verwerfen" drops it. Afterwards the card says what became of
 * it and links to the result. A letter (#1534) stays editable on the card
 * until it runs.
 */
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { discardProposal, downloadResult, executeProposal, type Proposal, type ProposalEdits } from '../../api/assistant'
import { letterGaps } from '../../utils/letterGaps'
import LetterEditor, { type LetterForm } from './LetterEditor.vue'

const props = defineProps<{ proposal: Proposal }>()

const current = ref<Proposal>({ ...props.proposal })
watch(() => props.proposal, (p) => { current.value = { ...p } })

function formOf(p: Proposal): LetterForm | null {
  const l = p.letter
  if (!l) return null
  return {
    sender: l.sender,
    recipient: l.recipient,
    subject: l.subject,
    body: l.body,
    destinations: [...l.destinations],
    attachmentIds: l.attachments.map((a) => a.id),
  }
}

const letterForm = ref<LetterForm | null>(formOf(props.proposal))
watch(() => props.proposal, (p) => { letterForm.value = formOf(p) })
const gaps = computed(() => {
  const f = letterForm.value
  return f && current.value.letter ? letterGaps(f.sender, f.recipient, f.subject, f.body) : []
})

function letterEdits(): ProposalEdits | undefined {
  const f = letterForm.value
  if (!f) return undefined
  return {
    sender: f.sender,
    recipient: f.recipient,
    subject: f.subject,
    body: f.body,
    destinations: f.destinations,
    attachment_ids: f.attachmentIds,
  }
}

/** The confirmed letter as an e-mail draft; the PDF has to be attached by hand. */
const mailto = computed(() => {
  const f = letterForm.value
  if (!f || current.value.status !== 'executed') return null
  return `mailto:?subject=${encodeURIComponent(f.subject)}&body=${encodeURIComponent(f.body)}`
})

const busy = ref<'execute' | 'discard' | null>(null)
const requestError = ref<string | null>(null)

const STATUS: Record<Proposal['status'], { label: string; severity: 'info' | 'success' | 'secondary' | 'warn' }> = {
  pending: { label: 'Wartet auf Bestätigung', severity: 'info' },
  executing: { label: 'Läuft', severity: 'warn' },
  executed: { label: 'Ausgeführt', severity: 'success' },
  discarded: { label: 'Verworfen', severity: 'secondary' },
}

const status = computed(() => STATUS[current.value.status])
const downloading = ref(false)

async function download() {
  const path = current.value.result_download
  if (!path || downloading.value) return
  downloading.value = true
  requestError.value = null
  try {
    await downloadResult(path)
  } catch (e) {
    requestError.value = e instanceof Error ? e.message : 'Der Download ist fehlgeschlagen.'
  } finally {
    downloading.value = false
  }
}
const error = computed(() => requestError.value ?? current.value.error)

async function decide(action: 'execute' | 'discard') {
  if (busy.value) return
  busy.value = action
  requestError.value = null
  try {
    const id = current.value.proposal_id
    const edits = action === 'execute' ? letterEdits() : undefined
    const next = action === 'execute'
      ? await (edits ? executeProposal(id, edits) : executeProposal(id))
      : await discardProposal(id)
    current.value = { ...next, count: next.count ?? current.value.count }
  } catch (e) {
    requestError.value = e instanceof Error ? e.message : 'Der Vorschlag konnte nicht bearbeitet werden.'
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section class="proposal" :class="`proposal--${current.status}`" aria-label="Vorschlag">
    <header class="proposal-head">
      <span class="proposal-title">
        <i class="pi pi-bolt" aria-hidden="true" />
        Vorschlag
      </span>
      <Tag :value="status.label" :severity="status.severity" />
    </header>

    <div class="proposal-body">
      <p class="proposal-summary">{{ current.summary }}</p>
      <LetterEditor
        v-if="letterForm && current.letter && current.status === 'pending'"
        v-model="letterForm"
        :letter="current.letter"
        :disabled="busy !== null"
        :id-prefix="`letter-${current.proposal_id}`"
      />
      <p v-if="current.status === 'executed' && current.result_summary" class="proposal-result">
        <i class="pi pi-check" aria-hidden="true" />
        <span>{{ current.result_summary }}</span>
        <RouterLink v-if="current.result_route" :to="current.result_route" class="proposal-link">Ansehen</RouterLink>
      </p>
      <div v-if="current.status === 'executed' && current.result_download" class="proposal-download">
        <Button
          label="PDF herunterladen"
          icon="pi pi-download"
          size="small"
          severity="secondary"
          outlined
          :loading="downloading"
          @click="download"
        />
        <a v-if="mailto" :href="mailto" class="proposal-mail">
          <i class="pi pi-envelope" aria-hidden="true" />
          Als E-Mail-Entwurf öffnen
        </a>
      </div>
      <p v-if="requestError && current.status === 'executed'" class="proposal-error" role="alert">
        <i class="pi pi-exclamation-circle" aria-hidden="true" />
        {{ requestError }}
      </p>
      <p v-if="error && current.status !== 'executed'" class="proposal-error" role="alert">
        <i class="pi pi-exclamation-circle" aria-hidden="true" />
        {{ error }}
      </p>
    </div>

    <footer v-if="current.status === 'pending'" class="proposal-foot">
      <Button
        label="Verwerfen"
        severity="secondary"
        text
        size="small"
        :loading="busy === 'discard'"
        :disabled="busy !== null"
        @click="decide('discard')"
      />
      <Button
        :label="error ? 'Erneut ausführen' : 'Ausführen'"
        icon="pi pi-play"
        size="small"
        :loading="busy === 'execute'"
        :disabled="busy !== null || gaps.length > 0"
        @click="decide('execute')"
      />
    </footer>
  </section>
</template>

<style scoped>
.proposal {
  border: 1px solid var(--p-primary-color);
  border-radius: 0.5rem;
  background: var(--p-content-background);
  min-width: 0;
}

.proposal--executed,
.proposal--discarded {
  border-color: var(--p-content-border-color);
}

.proposal-head,
.proposal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.proposal-head {
  border-bottom: 1px solid var(--p-content-border-color);
}

.proposal-foot {
  justify-content: flex-end;
  border-top: 1px solid var(--p-content-border-color);
}

.proposal-title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-weight: 600;
  font-size: var(--text-sm);
}

.proposal-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
}

.proposal-body p {
  margin: 0;
}

.proposal--discarded .proposal-summary {
  color: var(--p-text-muted-color);
  text-decoration: line-through;
}

.proposal-result,
.proposal-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  font-size: var(--text-sm);
}

.proposal-result {
  color: var(--p-green-600);
}

.proposal-link {
  margin-left: var(--space-2);
  color: var(--p-primary-color);
}

.proposal-error {
  color: var(--p-red-600);
}

.proposal-download {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.proposal-mail {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-sm);
  color: var(--p-primary-color);
}
</style>
