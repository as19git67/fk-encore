<script setup lang="ts">
/**
 * One message of the conversation (#1528): the user's question, or the
 * assistant's answer with what it looked up and the rows it found.
 */
import { computed } from 'vue'
import type { Proposal, ResultBlock } from '../../api/assistant'
import type { TurnStep } from '../../utils/assistantTurn'
import { parseBlocks } from '../../utils/assistantMarkdown'
import ScrollX from '../layout/ScrollX.vue'
import AssistantBlock from './AssistantBlock.vue'
import ProposalCard from './ProposalCard.vue'

const props = withDefaults(defineProps<{
  role: 'user' | 'assistant'
  content: string
  blocks?: ResultBlock[]
  /** What the assistant is doing or did while answering. */
  steps?: TurnStep[]
  /** The answer is still arriving. */
  pending?: boolean
  error?: string
  /** The stored message's id; rows of a stored answer can be returned to. */
  messageId?: number
}>(), { blocks: () => [], steps: () => [], pending: false, error: undefined, messageId: undefined })

// The assistant's bold, lists and code are rendered; the user's own text is
// shown as typed.
const rendered = computed(() => (props.role === 'assistant' ? parseBlocks(props.content) : []))

// A lookup that found nothing has its "· 0" in the steps above; an empty
// grid under the answer said the same thing again, with nothing in it.
const shownBlocks = computed(() => props.blocks.filter((b) => b.kind === 'analysis' || b.rows.length > 0))

// One answer often holds several lists of the same kind: the model searched
// the tax documents, then all documents, then summarised three. Only the
// last list of a kind is what the answer is about; the ones before it fold
// to their header so the thread stays readable (a click opens them).
function family(kind: string): string {
  return kind === 'document' ? 'documents' : kind
}
const lastOfFamily = computed(() => {
  const last = new Map<string, number>()
  shownBlocks.value.forEach((b, i) => last.set(family(b.kind), i))
  return last
})
function isFolded(i: number): boolean {
  const b = shownBlocks.value[i]
  return b !== undefined && b.kind !== 'analysis' && lastOfFamily.value.get(family(b.kind)) !== i
}
</script>

<template>
  <article :class="['message', `message--${role}`]" :aria-busy="pending || undefined">
    <h3 class="visually-hidden">{{ role === 'user' ? 'Deine Frage' : 'Antwort des Assistenten' }}</h3>

    <ul v-if="steps.length" class="steps" aria-label="Nachgesehen">
      <li v-for="(s, i) in steps" :key="`${s.tool}-${i}`" :class="['step', { 'step--failed': !!s.error }]">
        <i
          :class="['pi', !s.done ? 'pi-spin pi-spinner' : s.error ? 'pi-exclamation-triangle' : 'pi-check']"
          aria-hidden="true"
        />
        <span>{{ s.label }}</span>
        <span v-if="s.done && !s.error && s.rowCount !== undefined" class="step-count">· {{ s.rowCount }}</span>
      </li>
    </ul>

    <div v-if="content || (pending && !steps.length)" class="bubble">
      <div v-if="content && role === 'assistant'" class="text text--rich">
        <template v-for="(b, i) in rendered" :key="i">
          <p v-if="b.type === 'p'">
            <template v-for="(line, j) in b.lines" :key="j">
              <br v-if="j > 0" />
              <template v-for="(run, k) in line" :key="k">
                <strong v-if="run.bold">{{ run.text }}</strong>
                <em v-else-if="run.italic">{{ run.text }}</em>
                <code v-else-if="run.code">{{ run.text }}</code>
                <template v-else>{{ run.text }}</template>
              </template>
            </template>
          </p>
          <pre v-else-if="b.type === 'pre'">{{ b.text }}</pre>
          <ScrollX v-else-if="b.type === 'table'" class="table-scroll">
            <table>
              <thead v-if="b.head.length">
                <tr>
                  <th v-for="(cell, j) in b.head" :key="j" scope="col" :class="b.align[j] && `align-${b.align[j]}`">
                    <template v-for="(run, k) in cell" :key="k">
                      <strong v-if="run.bold">{{ run.text }}</strong>
                      <em v-else-if="run.italic">{{ run.text }}</em>
                      <code v-else-if="run.code">{{ run.text }}</code>
                      <template v-else>{{ run.text }}</template>
                    </template>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, r) in b.rows" :key="r">
                  <td v-for="(cell, j) in row" :key="j" :class="b.align[j] && `align-${b.align[j]}`">
                    <template v-for="(run, k) in cell" :key="k">
                      <strong v-if="run.bold">{{ run.text }}</strong>
                      <em v-else-if="run.italic">{{ run.text }}</em>
                      <code v-else-if="run.code">{{ run.text }}</code>
                      <template v-else>{{ run.text }}</template>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
          <component :is="b.type" v-else>
            <li v-for="(item, j) in b.items" :key="j">
              <template v-for="(run, k) in item" :key="k">
                <strong v-if="run.bold">{{ run.text }}</strong>
                <em v-else-if="run.italic">{{ run.text }}</em>
                <code v-else-if="run.code">{{ run.text }}</code>
                <template v-else>{{ run.text }}</template>
              </template>
            </li>
          </component>
        </template>
      </div>
      <p v-else-if="content" class="text">{{ content }}</p>
      <p v-else class="text text--waiting">
        <i class="pi pi-spin pi-spinner" aria-hidden="true" />
        Denkt nach …
      </p>
    </div>

    <p v-if="error" class="error" role="alert">
      <i class="pi pi-exclamation-circle" aria-hidden="true" />
      {{ error }}
    </p>

    <div v-if="shownBlocks.length" class="blocks">
      <template v-for="(b, i) in shownBlocks" :key="`${b.tool}-${i}`">
        <ProposalCard v-for="p in b.kind === 'proposal' ? b.rows : []" :key="String(p.proposal_id)" :proposal="(p as unknown as Proposal)" />
        <AssistantBlock
          v-if="b.kind !== 'proposal'"
          :block="b"
          :folded="isFolded(i)"
          :anchor-scope="messageId !== undefined ? `m${messageId}-${i}` : undefined"
        />
      </template>
    </div>
  </article>
</template>

<style scoped>
.message {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.message--user {
  align-items: flex-end;
}

.bubble {
  max-width: min(42rem, 100%);
  padding: var(--space-2) var(--space-3);
  border-radius: 0.75rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
}

.message--user .bubble {
  background: var(--p-primary-color);
  border-color: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}

.text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
}

.text--rich {
  white-space: normal;
}

.text--rich p,
.text--rich ul,
.text--rich ol,
.text--rich pre {
  margin: 0;
}

.text--rich > * + * {
  margin-top: var(--space-2);
}

/* ScrollX makes room for its focus ring with padding it takes off again
   outside; the gap above a table keeps that. */
.text--rich > .table-scroll {
  margin: calc(-1 * var(--focus-ring-reach));
}

.text--rich > * + .table-scroll {
  margin-top: calc(var(--space-2) - var(--focus-ring-reach));
}

.text--rich pre {
  font-size: 0.92em;
  white-space: pre-wrap;
  padding: var(--space-2);
  border-radius: 0.25em;
  background: rgba(0, 0, 0, 0.06);
}

.text--rich table {
  border-collapse: collapse;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.text--rich th,
.text--rich td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  text-align: left;
  vertical-align: top;
  overflow-wrap: normal;
}

.text--rich th {
  font-weight: 600;
  border-bottom-width: 2px;
}

.text--rich tbody tr:last-child td {
  border-bottom: none;
}

.text--rich .align-right {
  text-align: right;
  white-space: nowrap;
}

.text--rich .align-center {
  text-align: center;
}

.text--rich ul,
.text--rich ol {
  padding-left: 1.25em;
}

.text--rich code {
  font-size: 0.92em;
  padding: 0 0.25em;
  border-radius: 0.25em;
  background: rgba(0, 0, 0, 0.06);
}

.text--waiting {
  color: var(--p-text-muted-color);
}

.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.step {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.step-count {
  font-variant-numeric: tabular-nums;
}

.step--failed {
  color: var(--p-text-color);
}

.error {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-red-600);
}

.blocks {
  display: grid;
  gap: var(--space-2);
  width: min(42rem, 100%);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
