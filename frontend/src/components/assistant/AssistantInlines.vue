<script setup lang="ts">
/**
 * One line of an answer: plain, bold, italic and code runs, and the items
 * the answer names by id as links to their pages (`assistantLinks.ts`).
 */
import type { Inline } from '../../utils/assistantMarkdown'

defineProps<{ runs: Inline[] }>()
</script>

<template>
  <template v-for="(run, k) in runs" :key="k">
    <RouterLink v-if="run.to" class="entity-link" :to="run.to">
      <strong v-if="run.bold">{{ run.text }}</strong>
      <em v-else-if="run.italic">{{ run.text }}</em>
      <template v-else>{{ run.text }}</template>
    </RouterLink>
    <strong v-else-if="run.bold">{{ run.text }}</strong>
    <em v-else-if="run.italic">{{ run.text }}</em>
    <code v-else-if="run.code">{{ run.text }}</code>
    <template v-else>{{ run.text }}</template>
  </template>
</template>

<style scoped>
/*
 * A link inside running text is only as tall as the text. The padding gives
 * a finger more to hit and the negative margin takes it back, so the line
 * does not move.
 */
.entity-link {
  color: var(--p-primary-color);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.15em;
  padding: 0.35em 0.15em;
  margin: -0.35em -0.15em;
  border-radius: var(--p-border-radius-sm, 4px);
}

.entity-link:hover {
  text-decoration-thickness: 2px;
}

.entity-link:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
