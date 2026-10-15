import type { Meta, StoryObj } from '@storybook/vue3'
import FileButton from '../components/collections/FileButton.vue'
import { defaultHandlers } from './handlers'

/**
 * "Ablegen" (#1548): the one button on every detail page that opens the
 * dialog for the basket and the collections.
 */
const meta: Meta<typeof FileButton> = {
  title: 'Components/FileButton',
  component: FileButton,
  parameters: { msw: { handlers: defaultHandlers } },
  args: { members: [{ entity_type: 'photo', entity_id: 1 }], title: 'IMG_0001.jpg' },
}

export default meta
type Story = StoryObj<typeof FileButton>

export const NurIcon: Story = {}

export const MitText: Story = {
  args: { showLabel: true },
}
