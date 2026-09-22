import type { Meta, StoryObj } from '@storybook/vue3'
import PhotoPurgeView from '../views/PhotoPurgeView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'

/**
 * The danger zone under Fotos › Einstellungen (issue #1281). It loads
 * nothing and does one irreversible thing, so the single story is about the
 * warning being unmissable.
 */
const meta: Meta<typeof PhotoPurgeView> = {
  title: 'Views/PhotoPurgeView',
  component: PhotoPurgeView,
  decorators: [routeFromParameters('/fotos/einstellungen/gefahrenzone')],
  parameters: { msw: { handlers: defaultHandlers } },
}

export default meta
type Story = StoryObj<typeof PhotoPurgeView>

export const Gefahrenzone: Story = { name: 'Gefahrenzone' }

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
