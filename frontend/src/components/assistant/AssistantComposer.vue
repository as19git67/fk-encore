<script setup lang="ts">
/**
 * Where the question is typed (#1528). Enter sends, Shift+Enter breaks the
 * line; the field grows with its text up to a few lines, then scrolls.
 */
import { ref } from 'vue'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'

const props = withDefaults(defineProps<{
  busy?: boolean
  placeholder?: string
}>(), { busy: false, placeholder: 'Frag etwas über deine Finanzen, Dokumente, Fotos oder Zähler …' })

const emit = defineEmits<{ send: [message: string] }>()

const text = defineModel<string>({ default: '' })
const field = ref<{ $el: HTMLTextAreaElement } | null>(null)

function send() {
  const message = text.value.trim()
  if (!message || props.busy) return
  emit('send', message)
  text.value = ''
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  send()
}

defineExpose({ focus: () => field.value?.$el.focus() })
</script>

<template>
  <form class="composer" @submit.prevent="send">
    <label class="visually-hidden" for="assistant-question">Frage an den Assistenten</label>
    <Textarea
      id="assistant-question"
      ref="field"
      v-model="text"
      class="field"
      rows="1"
      auto-resize
      :placeholder="placeholder"
      :aria-busy="busy || undefined"
      @keydown="onKeydown"
    />
    <Button
      type="submit"
      icon="pi pi-send"
      rounded
      :loading="busy"
      :disabled="!text.trim() || busy"
      aria-label="Frage senden"
    />
  </form>
</template>

<style scoped>
.composer {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  padding: var(--space-2) var(--focus-ring-reach);
}

.field {
  flex: 1;
  min-width: 0;
  max-height: 12rem;
  overflow-y: auto !important;
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
