<script setup lang="ts">
/**
 * One message of the conversation (#1528): the user's question, or the
 * assistant's answer with what it looked up and the rows it found.
 */
import { computed } from 'vue'
import type { Proposal, ResultBlock } from '../../api/assistant'
import type { TurnStep } from '../../utils/assistantTurn'
import { parseBlocks } from '../../utils/assistantMarkdown'
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
}>(), { blocks: () => [], steps: () => [], pending: false, error: undefined })

// The assistant's bold, lists and code are rendered; the user's own text is
// shown as typed.
const rendered = computed(() => (props.role === 'assistant' ? parseBlocks(props.content) : []))

// A lookup that found nothing has its "· 0" in the steps above; an empty
// grid under the answer said the same thing again, with nothing in it.
const shownBlocks = computed(() => props.blocks.filter((b) => b.kind === 'analysis' || b.rows.length > 0))
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
        <AssistantBlock v-if="b.kind !== 'proposal'" :block="b" />
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
.text--rich ol {
  margin: 0;
}

.text--rich p + p,
.text--rich p + ul,
.text--rich p + ol,
.text--rich ul + p,
.text--rich ol + p {
  margin-top: var(--space-2);
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
