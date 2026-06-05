import { describe, it, expect, afterEach } from 'vitest'
import { isFullscreenInteractiveTarget, isFullscreenToolbarTarget } from './fullscreenInteractive'

describe('isFullscreenInteractiveTarget', () => {
  afterEach(() => { document.body.innerHTML = '' })

  function mount(html: string): HTMLElement {
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.appendChild(root)
    return root
  }

  it('matches a button inside the top toolbar', () => {
    const root = mount('<div class="fs-topbar"><button id="b"><i></i></button></div>')
    // The <i> is what a real tap lands on; closest() climbs to the button/topbar.
    expect(isFullscreenInteractiveTarget(root.querySelector('i'))).toBe(true)
    expect(isFullscreenInteractiveTarget(root.querySelector('#b'))).toBe(true)
  })

  it('matches the bottom action bar', () => {
    const root = mount('<div class="fs-actions-bar"><span id="s">x</span></div>')
    expect(isFullscreenInteractiveTarget(root.querySelector('#s'))).toBe(true)
  })

  it('does not match the bare photo pane', () => {
    const root = mount('<div class="fs-split-photo"><img id="img" /></div>')
    expect(isFullscreenInteractiveTarget(root.querySelector('#img'))).toBe(false)
  })

  it('returns false for null / non-element targets', () => {
    expect(isFullscreenInteractiveTarget(null)).toBe(false)
    expect(isFullscreenInteractiveTarget(document)).toBe(false)
  })
})

describe('isFullscreenToolbarTarget (slideshow idle-reset exclusion)', () => {
  afterEach(() => { document.body.innerHTML = '' })
  function mount(html: string): HTMLElement {
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.appendChild(root)
    return root
  }

  it('matches toolbar action buttons (details / favorite / hide → keep slideshow running)', () => {
    const root = mount('<div class="fs-actions-bar"><button><i id="i"></i></button></div>')
    expect(isFullscreenToolbarTarget(root.querySelector('#i'))).toBe(true)
  })

  it('matches the top bar', () => {
    const root = mount('<div class="fs-topbar"><button id="b"></button></div>')
    expect(isFullscreenToolbarTarget(root.querySelector('#b'))).toBe(true)
  })

  it('does NOT match the details flyout — typing there should still reset the timer', () => {
    const root = mount('<div class="fs-details-flyout"><textarea id="t"></textarea></div>')
    expect(isFullscreenToolbarTarget(root.querySelector('#t'))).toBe(false)
  })

  it('does NOT match the bare photo pane', () => {
    const root = mount('<div class="fs-split-photo"><img id="img" /></div>')
    expect(isFullscreenToolbarTarget(root.querySelector('#img'))).toBe(false)
  })
})
