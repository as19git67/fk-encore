import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import PrimeVue from 'primevue/config'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import Listbox from 'primevue/listbox'
import AutoComplete from 'primevue/autocomplete'
import { searchInputAttrs, searchInputPassThrough } from './searchInputAttrs'

function expectNoTextHelp(input: Element | null) {
  expect(input).not.toBeNull()
  expect(input!.getAttribute('autocorrect')).toBe('off')
  expect(input!.getAttribute('autocapitalize')).toBe('off')
  expect(input!.getAttribute('spellcheck')).toBe('false')
  expect(input!.getAttribute('autocomplete')).toBe('off')
}

async function mountWithGlobalPt(render: () => ReturnType<typeof h>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({ render }))
  app.use(PrimeVue, { pt: searchInputPassThrough })
  app.mount(host)
  await nextTick()
  return { host, unmount: () => { app.unmount(); host.remove() } }
}

const options = [{ label: 'Alpha', value: 'a' }, { label: 'Beta', value: 'b' }]

describe('searchInputPassThrough', () => {
  // jsdom has no matchMedia; Select listens for orientation changes.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia

  it('turns off spell checking in the Select filter', async () => {
    const { unmount } = await mountWithGlobalPt(() =>
      h(Select, { options, optionLabel: 'label', filter: true, appendTo: 'self', defaultValue: null }))
    document.querySelector<HTMLElement>('.p-select')!.click()
    await nextTick()
    await nextTick()
    expectNoTextHelp(document.querySelector('.p-select-filter'))
    unmount()
  })

  it('turns off spell checking in the MultiSelect filter', async () => {
    const { unmount } = await mountWithGlobalPt(() =>
      h(MultiSelect, { options, optionLabel: 'label', filter: true, appendTo: 'self' }))
    document.querySelector<HTMLElement>('.p-multiselect')!.click()
    await nextTick()
    await nextTick()
    expectNoTextHelp(document.querySelector('.p-multiselect-filter'))
    unmount()
  })

  it('turns off spell checking in the Listbox filter', async () => {
    const { host, unmount } = await mountWithGlobalPt(() =>
      h(Listbox, { options, optionLabel: 'label', filter: true }))
    expectNoTextHelp(host.querySelector('.p-listbox-filter'))
    unmount()
  })

  it('turns off spell checking in AutoComplete, single and multiple', async () => {
    const single = await mountWithGlobalPt(() => h(AutoComplete, { suggestions: [] }))
    expectNoTextHelp(single.host.querySelector('input'))
    single.unmount()

    const multiple = await mountWithGlobalPt(() => h(AutoComplete, { suggestions: [], multiple: true }))
    expectNoTextHelp(multiple.host.querySelector('input'))
    multiple.unmount()
  })
})

// Every hand-written search field binds searchInputAttrs. A field counts as a
// search field when its placeholder, label, type, test id or model says so.
const SEARCH_HINT = /such|search|query|filter/i
const TAG = /<(InputText|input)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return vueFiles(path)
    return path.endsWith('.vue') ? [path] : []
  })
}

describe('hand-written search inputs', () => {
  it('bind searchInputAttrs', () => {
    const root = join(__dirname, '..')
    const missing: string[] = []
    for (const file of vueFiles(root)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(TAG)) {
        const attrs = match[2]!
        if (/type="(checkbox|radio|file|number|range|hidden|color)"/.test(attrs)) continue
        if (!SEARCH_HINT.test(attrs)) continue
        if (attrs.includes('searchInputAttrs')) continue
        const line = source.slice(0, match.index).split('\n').length
        missing.push(`${relative(root, file)}:${line}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('exposes the four attributes as strings', () => {
    expect(searchInputAttrs).toEqual({
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
    })
  })
})
