import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MarkdownView from './MarkdownView.vue'

async function render(props: Record<string, unknown>): Promise<HTMLElement> {
  const host = document.createElement('div')
  createApp({ render: () => h(MarkdownView, props as never) }).mount(host)
  await nextTick()
  return host
}

describe('MarkdownView images', () => {
  it('shows a handbook photo only where the page says where to load it', async () => {
    const source = 'Vorher:\n\n![Alter Filter](media:4)\n\n![Fremd](https://example.test/x.jpg)'
    const withMedia = await render({ source, mediaUrl: (id: number) => `/api/home/media/${id}/file` })
    const imgs = [...withMedia.querySelectorAll('img')]
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/home/media/4/file'])
    expect(imgs[0]!.getAttribute('alt')).toBe('Alter Filter')
    expect(withMedia.textContent).toContain('[Bild: Fremd]')

    const without = await render({ source })
    expect(without.querySelectorAll('img')).toHaveLength(0)
    expect(without.textContent).toContain('[Bild: Alter Filter]')
  })
})
