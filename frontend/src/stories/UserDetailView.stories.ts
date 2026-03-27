import type { Meta, StoryObj } from '@storybook/vue3'
import UserDetailView from '../views/UserDetailView.vue'
import { defaultHandlers } from './handlers'
import { useRouter } from 'vue-router'
import { onBeforeMount } from 'vue'

// Decorator: navigate to /users/1 so useRoute().params.id is available
const withRoute = () => ({
  setup() {
    const router = useRouter()
    onBeforeMount(() => router.push('/users/1'))
    return {}
  },
  template: '<story />',
})

const meta: Meta<typeof UserDetailView> = {
  title: 'Views/UserDetailView',
  component: UserDetailView,
  decorators: [withRoute],
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof UserDetailView>

export const Default: Story = {
  name: 'Benutzer-Detail',
}
