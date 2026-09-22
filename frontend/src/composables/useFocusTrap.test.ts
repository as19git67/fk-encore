import { describe, it, expect, vi } from 'vitest'
import { createApp, defineComponent, nextTick, ref, type Ref } from 'vue'
import { focusableWithin, useFocusTrap } from './useFocusTrap'

/**
 * The three obligations a modal owes the keyboard: focus goes in, Tab stays
 * in, focus comes back out. jsdom does not move focus on Tab by itself —
 * which suits these tests, since moving it is exactly what the trap does.
 */

function mountTrap(
  active: Ref<boolean>,
  container: Ref<HTMLElement | null>,
  options: Parameters<typeof useFocusTrap>[2] = {},
) {
  const app = createApp(
    defineComponent({
      setup() {
        useFocusTrap(container, active, options)
        return () => null
      },
    }),
  )
  app.mount(document.createElement('div'))
  return () => app.unmount()
}

/** An overlay with the given controls, plus a button on the page behind it. */
function scene(inside = ['a', 'b', 'c']) {
  document.body.innerHTML = ''
  const opener = document.createElement('button')
  opener.id = 'opener'
  document.body.appendChild(opener)

  const overlay = document.createElement('div')
  for (const name of inside) {
    const b = document.createElement('button')
    b.id = name
    overlay.appendChild(b)
  }
  document.body.appendChild(overlay)
  // jsdom gives everything a zero-size box, so the visibility filter would
  // drop them all; say they are on screen.
  for (const el of [opener, ...Array.from(overlay.querySelectorAll('button'))]) {
    el.getClientRects = () => [{}] as unknown as DOMRectList
  }
  return { opener, overlay }
}

function tab(shift = false) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }))
}

describe('focusableWithin', () => {
  it('leaves out what is disabled or not on screen', () => {
    document.body.innerHTML = `
      <div id="root">
        <button id="ok"></button>
        <button id="off" disabled></button>
        <button id="hidden"></button>
        <div tabindex="-1" id="programmatic"></div>
      </div>`
    const root = document.getElementById('root')!
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, div'))) {
      el.getClientRects = () => (el.id === 'hidden' ? [] : [{}]) as unknown as DOMRectList
    }
    expect(focusableWithin(root).map((el) => el.id)).toEqual(['ok'])
  })
})

describe('useFocusTrap', () => {
  it('moves the focus into the overlay when it opens', async () => {
    const { opener, overlay } = scene()
    opener.focus()
    const active = ref(false)
    const unmount = mountTrap(active, ref(overlay))

    active.value = true
    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('a')
    unmount()
  })

  it('focuses an overlay that is already open when it mounts', async () => {
    // The usual shape: the parent `v-if`s the overlay, so the component
    // comes into existence open and nothing ever changes.
    const { opener, overlay } = scene()
    opener.focus()
    const unmount = mountTrap(ref(true), ref(overlay))

    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('a')
    unmount()
  })

  it('starts where the caller says, when it says', async () => {
    const { overlay } = scene()
    const active = ref(false)
    const unmount = mountTrap(active, ref(overlay), {
      initialFocus: () => overlay.querySelector<HTMLElement>('#c'),
    })

    active.value = true
    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('c')
    unmount()
  })

  it('cycles at both ends and never leaves', async () => {
    const { overlay } = scene()
    const active = ref(true)
    const unmount = mountTrap(active, ref(overlay))

    overlay.querySelector<HTMLElement>('#c')!.focus()
    tab()
    expect(document.activeElement?.id).toBe('a')

    tab(true)
    expect(document.activeElement?.id).toBe('c')
    unmount()
  })

  it('leaves a Tab in the middle of the overlay to the browser', async () => {
    const { overlay } = scene()
    const active = ref(true)
    const unmount = mountTrap(active, ref(overlay))

    overlay.querySelector<HTMLElement>('#b')!.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement?.id).toBe('b')
    unmount()
  })

  it('pulls focus back in when it has escaped the overlay', async () => {
    const { opener, overlay } = scene()
    const active = ref(true)
    const unmount = mountTrap(active, ref(overlay))

    opener.focus() // e.g. a click on the backdrop
    tab()
    expect(document.activeElement?.id).toBe('a')
    unmount()
  })

  it('holds the focus when the overlay has nothing to focus', async () => {
    const { opener, overlay } = scene([])
    const active = ref(true)
    const unmount = mountTrap(active, ref(overlay))

    opener.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    unmount()
  })

  it('gives the focus back to whatever opened it', async () => {
    const { opener, overlay } = scene()
    opener.focus()
    const active = ref(false)
    const unmount = mountTrap(active, ref(overlay))

    active.value = true
    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('a')

    active.value = false
    await nextTick()
    expect(document.activeElement?.id).toBe('opener')
    unmount()
  })

  it('does not chase an opener that is gone', async () => {
    const { opener, overlay } = scene()
    opener.focus()
    const active = ref(false)
    const unmount = mountTrap(active, ref(overlay))

    active.value = true
    await nextTick()
    await nextTick()
    opener.remove() // the row the overlay was opened from was deleted
    active.value = false
    await nextTick()
    expect(document.activeElement?.id).not.toBe('opener')
    unmount()
  })

  it('gives the focus back when the overlay is unmounted instead of closed', async () => {
    // How nearly every one of these overlays actually closes: the parent
    // `v-if`s it away, so `active` stays true to the last and the watcher
    // never sees a change. Without the unmount hook the focus was left on
    // <body> and the reader started again at the top of the page.
    const { opener, overlay } = scene()
    opener.focus()
    const unmount = mountTrap(ref(true), ref(overlay))

    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('a')

    unmount()
    expect(document.activeElement?.id).toBe('opener')
  })

  it('leaves a dialog that opened on top of it to itself', async () => {
    // A PrimeVue Dialog opened from inside the overlay is teleported to
    // <body>, so it sits outside the container although it is the surface
    // the user is on. Reclaiming its keys made it unusable: Tab was pulled
    // back into the overlay and Escape closed the overlay underneath it.
    const { overlay } = scene()
    const onEscape = vi.fn()
    const unmount = mountTrap(ref(true), ref(overlay), { onEscape })

    const dialog = document.createElement('div')
    dialog.className = 'p-dialog'
    const field = document.createElement('input')
    dialog.appendChild(field)
    document.body.appendChild(dialog)
    field.getClientRects = () => [{}] as unknown as DOMRectList
    field.focus()

    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    field.dispatchEvent(tabEvent)
    expect(tabEvent.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(field)

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(onEscape).not.toHaveBeenCalled()

    dialog.remove()
    unmount()
  })

  it('calls onEscape, and only while open', async () => {
    const { overlay } = scene()
    const onEscape = vi.fn()
    const active = ref(false)
    const unmount = mountTrap(active, ref(overlay), { onEscape })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(onEscape).not.toHaveBeenCalled()

    active.value = true
    await nextTick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(onEscape).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('stops listening once the component is gone', async () => {
    const { overlay } = scene()
    const onEscape = vi.fn()
    const active = ref(true)
    const unmount = mountTrap(active, ref(overlay), { onEscape })
    unmount()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(onEscape).not.toHaveBeenCalled()
  })
})
