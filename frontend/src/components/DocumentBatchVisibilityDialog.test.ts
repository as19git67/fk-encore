import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import PrimeVue from 'primevue/config'
import type { DocumentSummary, GroupSummary } from '../api/documents'

vi.mock('../api/documents', () => ({
  batchUpdateDocumentVisibility: vi.fn(),
  getUploadDefaults: vi.fn(),
}))

const requireConfirm = vi.fn()
vi.mock('primevue/useconfirm', () => ({ useConfirm: () => ({ require: requireConfirm }) }))

import { batchUpdateDocumentVisibility, getUploadDefaults } from '../api/documents'
import DocumentBatchVisibilityDialog from './DocumentBatchVisibilityDialog.vue'

const GROUPS: GroupSummary[] = [
  { id: 1, slug: 'familie', name: 'Familie', my_role: 'member', member_count: 3 },
  { id: 2, slug: 'verein', name: 'Verein', my_role: 'member', member_count: 5 },
]

function doc(id: number, group: number | null): DocumentSummary {
  return {
    id,
    visibility: group == null ? 'private' : 'group',
    group_id: group,
  } as DocumentSummary
}

// PrimeVue's Select listens for orientation changes; jsdom has no matchMedia.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

const flush = () => new Promise((r) => setTimeout(r, 0))

let app: App | null = null

async function open(documents: DocumentSummary[]) {
  const visible = ref(false)
  const el = document.createElement('div')
  document.body.appendChild(el)
  app = createApp({
    render: () =>
      h(DocumentBatchVisibilityDialog, {
        visible: visible.value,
        documents,
        groups: GROUPS,
        'onUpdate:visible': (v: boolean) => (visible.value = v),
      }),
  }).use(PrimeVue)
  app.mount(el)
  visible.value = true
  await nextTick()
  await flush()
  await nextTick()
}

function radio(id: string): HTMLInputElement {
  return document.body.querySelector(`#${id}`) as HTMLInputElement
}

function button(label: string): HTMLButtonElement {
  const b = [...document.body.querySelectorAll('button')].find((x) => x.textContent?.includes(label))
  if (!b) throw new Error(`no button ${label}`)
  return b
}

beforeEach(() => {
  vi.mocked(batchUpdateDocumentVisibility).mockReset()
  vi.mocked(batchUpdateDocumentVisibility).mockResolvedValue({
    affected_documents: 1,
    skipped_unauthorized: 0,
  } as Awaited<ReturnType<typeof batchUpdateDocumentVisibility>>)
  vi.mocked(getUploadDefaults).mockReset()
  requireConfirm.mockReset()
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
})

describe('DocumentBatchVisibilityDialog', () => {
  it('starts a mixed selection on the default group, not on private', async () => {
    vi.mocked(getUploadDefaults).mockResolvedValue({ group_id: 2, stale: false })
    await open([doc(1, 1), doc(2, null), doc(3, 1)])
    expect(radio('vis-group').checked).toBe(true)
    expect(document.body.textContent).toContain('Verein')
    expect(document.body.textContent).toContain('1 privat, 2 in Familie')
  })

  it('falls back to the first group when the default no longer applies', async () => {
    vi.mocked(getUploadDefaults).mockResolvedValue({ group_id: 2, stale: true })
    await open([doc(1, 2), doc(2, null)])
    expect(radio('vis-group').checked).toBe(true)
    expect(document.body.textContent).toContain('Familie')
  })

  it('asks before taking group documents out of their group', async () => {
    await open([doc(1, 1), doc(2, 1)])
    radio('vis-private').click()
    await nextTick()
    button('Anwenden').click()
    await flush()

    expect(batchUpdateDocumentVisibility).not.toHaveBeenCalled()
    expect(requireConfirm).toHaveBeenCalledTimes(1)
    const opts = requireConfirm.mock.calls[0]![0]
    expect(opts.message).toContain('2 Dokumente')
    expect(opts.defaultFocus).toBe('reject')

    opts.accept()
    await flush()
    expect(batchUpdateDocumentVisibility).toHaveBeenCalledWith({
      document_ids: [1, 2],
      visibility: 'private',
      group_id: null,
    })
  })

  it('applies private documents without asking', async () => {
    await open([doc(1, null), doc(2, null)])
    expect(radio('vis-private').checked).toBe(true)
    button('Anwenden').click()
    await flush()
    expect(requireConfirm).not.toHaveBeenCalled()
    expect(batchUpdateDocumentVisibility).toHaveBeenCalledTimes(1)
  })
})
