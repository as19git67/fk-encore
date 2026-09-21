import type { Meta, StoryObj } from '@storybook/vue3'
import FacePhotoGrid, { type FacePhotoItem } from '../components/FacePhotoGrid.vue'

/**
 * The grid of a person's photos, each tile with the yellow face rectangle.
 *
 * The tile zooms and shifts the image so the face centre sits in the middle
 * of the tile — see `utils/faceBbox.ts`. That is what makes this story
 * measurable: whatever the photo's own proportions, the centre of the face
 * box must land on the centre of the tile. If the overlay and the image ever
 * drift apart (issue: "das Rechteck ist horizontal versetzt"), the two
 * centres separate and the play function below says by how much.
 */
const meta: Meta<typeof FacePhotoGrid> = {
  title: 'Components/FacePhotoGrid',
  component: FacePhotoGrid,
}

export default meta
type Story = StoryObj<typeof FacePhotoGrid>

/** One bbox per tile, deliberately off-centre in both axes. */
const BBOXES = [
  { x: 0.12, y: 0.18, width: 0.18, height: 0.24 },
  { x: 0.62, y: 0.12, width: 0.14, height: 0.2 },
  { x: 0.4, y: 0.55, width: 0.22, height: 0.28 },
  { x: 0.08, y: 0.62, width: 0.16, height: 0.22 },
  { x: 0.7, y: 0.66, width: 0.2, height: 0.26 },
]
const FILES = ['castle.jpg', 'fish.jpg', 'museum.jpg', 'seagull.jpg', 'steak.jpg']

const items: FacePhotoItem[] = FILES.map((filename, i) => ({
  face: { id: 100 + i, bbox: BBOXES[i]! },
  photo: { id: 200 + i, filename, original_name: filename },
}))

function frame(inner: string, width: string) {
  return {
    components: { FacePhotoGrid },
    data: () => ({ items, selectedIndex: 0 }),
    template: `<div style="width:100%; max-width:${width}; height:520px">${inner}</div>`,
  }
}

const grid = `<FacePhotoGrid :items="items" v-model:selectedIndex="selectedIndex" />`

export const Raster: Story = {
  render: () => frame(grid, '640px'),
  play: async ({ canvasElement }) => {
    await expectFaceBoxesCentred(canvasElement)
  },
}

export const Schmal: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
  render: () => frame(grid, '100%'),
  play: async ({ canvasElement }) => {
    await expectFaceBoxesCentred(canvasElement)
  },
}

export const BreiteKacheln: Story = {
  name: 'Breite Kacheln',
  render: () => frame(grid, '1100px'),
  play: async ({ canvasElement }) => {
    await expectFaceBoxesCentred(canvasElement)
  },
}

/**
 * Waits for the thumbnails to decode, then compares each face box's centre
 * with its tile's centre. Tolerance is one pixel of rounding plus the box's
 * own border.
 */
async function expectFaceBoxesCentred(canvasElement: HTMLElement) {
  const imgs = Array.from(canvasElement.querySelectorAll('img'))
  await Promise.all(
    imgs.map((img) =>
      img.complete && img.naturalWidth
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true })
            img.addEventListener('error', () => resolve(), { once: true })
          }),
    ),
  )
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  const thumbs = Array.from(canvasElement.querySelectorAll<HTMLElement>('.photo-thumb'))
  if (thumbs.length === 0) throw new Error('no tiles rendered')
  const offsets: string[] = []
  for (const thumb of thumbs) {
    const box = thumb.querySelector<HTMLElement>('.face-box')
    if (!box) continue
    const t = thumb.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    const dx = b.left + b.width / 2 - (t.left + t.width / 2)
    const dy = b.top + b.height / 2 - (t.top + t.height / 2)
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      offsets.push(`dx=${dx.toFixed(1)}px dy=${dy.toFixed(1)}px (tile ${t.width.toFixed(0)}px)`)
    }
  }
  if (offsets.length > 0) {
    throw new Error(`face box off the tile centre: ${offsets.join('; ')}`)
  }
}
