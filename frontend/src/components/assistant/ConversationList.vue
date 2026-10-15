<script setup lang="ts">
/**
 * The user's conversations with the assistant, newest first (#1528).
 * Beside the chat from `lg`, in a drawer below.
 */
import Button from 'primevue/button'
import type { ConversationSummary } from '../../api/assistant'

defineProps<{
  conversations: ConversationSummary[]
  activeId: number | null
}>()

const emit = defineEmits<{
  select: [id: number]
  start: []
  remove: [conversation: ConversationSummary]
}>()

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
</script>

<template>
  <nav class="conversations" aria-label="Unterhaltungen">
    <Button
      class="start"
      icon="pi pi-plus"
      label="Neue Unterhaltung"
      severity="secondary"
      outlined
      @click="emit('start')"
    />
    <p v-if="!conversations.length" class="empty">Noch keine Unterhaltungen.</p>
    <ul v-else class="list">
      <li v-for="c in conversations" :key="c.id" :class="['item', { 'item--active': c.id === activeId }]">
        <button
          type="button"
          class="open"
          :aria-current="c.id === activeId ? 'true' : undefined"
          @click="emit('select', c.id)"
        >
          <span class="title">{{ c.title || 'Neue Unterhaltung' }}</span>
          <span class="date">{{ when(c.updated_at) }}</span>
        </button>
        <Button
          icon="pi pi-trash"
          severity="secondary"
          text
          rounded
          size="small"
          :aria-label="`Unterhaltung „${c.title || 'Neue Unterhaltung'}“ löschen`"
          @click="emit('remove', c)"
        />
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.conversations {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--focus-ring-reach);
}

.start {
  width: 100%;
}

.empty {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  border-radius: 0.5rem;
  min-width: 0;
}

.item--active {
  background: var(--p-content-hover-background);
}

.open {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--space-2);
  border: none;
  border-radius: 0.5rem;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.open:hover {
  background: var(--p-content-hover-background);
}

.open:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.title {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item--active .title {
  font-weight: 600;
}

.date {
  color: var(--p-text-muted-color);
  font-size: var(--text-xs);
}
</style>
