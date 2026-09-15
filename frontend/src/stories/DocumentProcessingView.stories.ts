import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentProcessingView from '../views/DocumentProcessingView.vue'
import { defaultHandlers } from './handlers'

const meta: Meta<typeof DocumentProcessingView> = {
  title: 'Views/DocumentProcessingView',
  component: DocumentProcessingView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof DocumentProcessingView>

export const Default: Story = {
  name: 'Dokument-Verarbeitung',
}
