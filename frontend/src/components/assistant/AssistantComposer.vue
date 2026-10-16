<script setup lang="ts">
/**
 * Where the question is typed (#1528). Enter sends, Shift+Enter breaks the
 * line; the field grows with its text up to a few lines, then scrolls.
 *
 * The growing is ours, not PrimeVue's `auto-resize`: that one sets the
 * border-box height to `scrollHeight`, which leaves the content two border
 * widths short, and with a scrolling field that shows as a permanent
 * scrollbar on a single line. Here the border is added, and the field only
 * scrolls once it has reached its full height.
 */
import { nextTick, onMounted, ref, watch } from 'vue'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'

const props = withDefaults(defineProps<{
  busy?: boolean
  placeholder?: string
}>(), { busy: false, placeholder: 'Was möchtest du wissen?' })

const emit = defineEmits<{ send: [message: string] }>()

const text = defineModel<string>({ default: '' })
const field = ref<{ $el: HTMLTextAreaElement } | null>(null)

/** The field's full height in px before it scrolls: about six lines. */
const MAX_HEIGHT = 192

function resize() {
  const el = field.value?.$el
  if (!el) return
  el.style.height = 'auto'
  const border = el.offsetHeight - el.clientHeight
  const wanted = el.scrollHeight + border
  el.style.height = `${Math.min(wanted, MAX_HEIGHT)}px`
  el.style.overflowY = wanted > MAX_HEIGHT ? 'auto' : 'hidden'
}

// Typing resizes on input; a value set from outside (the cleared field
// after sending, a question handed over by another page) resizes here.
watch(text, () => { void nextTick(resize) })

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

onMounted(resize)
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
      :placeholder="placeholder"
      :aria-busy="busy || undefined"
      @keydown="onKeydown"
      @input="resize"
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
  /* Clear of the home indicator on a phone: the app draws edge to edge
     (viewport-fit=cover), so the bottom inset is ours to keep free. On a
     desktop the inset is 0 and the field sat on the window's edge; the
     page's own bottom padding is what it gets instead. */
  padding: var(--space-2) var(--focus-ring-reach) calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
}

.field {
  flex: 1;
  min-width: 0;
  resize: none;
  overflow-y: hidden;
}

.field::placeholder {
  font-size: var(--text-sm);
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
