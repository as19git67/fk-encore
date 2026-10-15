import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import PrimeVue from 'primevue/config'
import AssistantComposer from './AssistantComposer.vue'

// PrimeVue's auto-resize watches the field; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

function mountComposer(initial = '') {
  const sent: string[] = []
  const text = ref(initial)
  const el = document.createElement('div')
  document.body.appendChild(el)
  createApp({
    render: () => h(AssistantComposer, {
      modelValue: text.value,
      'onUpdate:modelValue': (v: string) => { text.value = v },
      onSend: (m: string) => sent.push(m),
    }),
  }).use(PrimeVue).mount(el)
  const field = el.querySelector('textarea')!
  return { sent, text, field }
}

function press(field: HTMLTextAreaElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
  field.dispatchEvent(event)
  return event
}

describe('AssistantComposer', () => {
  it('Enter sends the trimmed question and clears the field', async () => {
    const { sent, text, field } = mountComposer('  Welche Konten habe ich?  ')
    const event = press(field, {})
    await nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(sent).toEqual(['Welche Konten habe ich?'])
    expect(text.value).toBe('')
  })

  it('Shift+Enter breaks the line instead of sending', () => {
    const { sent, field } = mountComposer('Erste Zeile')
    const event = press(field, { shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(sent).toEqual([])
  })

  it('an empty question is not sent', () => {
    const { sent, field } = mountComposer('   ')
    press(field, {})
    expect(sent).toEqual([])
  })
})
