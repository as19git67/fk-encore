import { describe, it, expect, afterEach } from 'vitest'
import { hasOpenOverlay, overlayAbove } from './overlayLayer'

/**
 * Which layer a key belongs to. The two questions this answers decide
 * whether a list leaves select mode on Escape and whether a focus trap
 * reclaims a Tab — both of which were wrong for anything that opens on top.
 */

afterEach(() => {
  document.body.innerHTML = ''
})

function el(html: string): HTMLElement {
  document.body.insertAdjacentHTML('beforeend', html)
  return document.body.lastElementChild as HTMLElement
}

describe('overlayAbove', () => {
  it('finds the dialog an event came out of', () => {
    const dialog = el('<div class="p-dialog"><button id="ok">OK</button></div>')
    expect(overlayAbove(dialog.querySelector('#ok'))).toBe(dialog)
  })

  it('recognises a hand-built overlay by its role', () => {
    const sheet = el('<div role="dialog"><input id="field" /></div>')
    expect(overlayAbove(sheet.querySelector('#field'))).toBe(sheet)
  })

  it('says nothing about a plain page element', () => {
    const row = el('<div class="row"><button id="open">Öffnen</button></div>')
    expect(overlayAbove(row.querySelector('#open'))).toBeNull()
  })

  it('does not count a surface as being above itself', () => {
    // The trap's own container says `role="dialog"`, and everything inside
    // it belongs to the trap, not to some layer on top.
    const overlay = el('<div role="dialog"><button id="close">Schließen</button></div>')
    expect(overlayAbove(overlay.querySelector('#close'), overlay)).toBeNull()
    expect(overlayAbove(overlay, overlay)).toBeNull()
  })

  it('sees the dialog a trapped overlay opened, teleported out of it', () => {
    // PrimeVue moves the dialog to <body>, so it is not inside the overlay
    // that owns it — which is exactly why the container test alone was wrong.
    const overlay = el('<div role="dialog" id="sheet"><button>Menü</button></div>')
    const dialog = el('<div class="p-dialog"><button id="save">Sichern</button></div>')
    expect(overlayAbove(dialog.querySelector('#save'), overlay)).toBe(dialog)
  })

  it('ignores a target that is not an element', () => {
    expect(overlayAbove(document)).toBeNull()
    expect(overlayAbove(null)).toBeNull()
  })
})

describe('hasOpenOverlay', () => {
  it('is false on a page with nothing on top of it', () => {
    el('<div class="page"><button>Sortieren</button></div>')
    expect(hasOpenOverlay()).toBe(false)
  })

  it('is true while a popup menu is open', () => {
    // The menu the sort button opens: Escape belongs to it, even though
    // PrimeVue only moves the focus into it when it was opened by keyboard.
    el('<div class="p-menu p-menu-overlay"><ul role="menu"></ul></div>')
    expect(hasOpenOverlay()).toBe(true)
  })

  it('leaves an inline menu or listbox alone', () => {
    // Those carry their role all the time. Counting them would swallow
    // Escape for good on any page that renders one.
    el('<ul role="menu"><li>Immer da</li></ul>')
    el('<ul role="listbox"><li>Auch</li></ul>')
    expect(hasOpenOverlay()).toBe(false)
  })
})
