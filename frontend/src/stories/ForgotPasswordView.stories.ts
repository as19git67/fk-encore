import type { Meta, StoryObj } from '@storybook/vue3'
import { h } from 'vue'
import { useRouter } from 'vue-router'
import ForgotPasswordView from '../views/ForgotPasswordView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const meta: Meta<typeof ForgotPasswordView> = {
  title: 'Views/ForgotPasswordView',
  component: ForgotPasswordView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof ForgotPasswordView>

function withRoute(targetPath: string) {
  return (story: any) => ({
    components: { Story: story() },
    setup() {
      const router = useRouter()
      if (router.currentRoute.value.fullPath !== targetPath) {
        router.push(targetPath).catch(() => {})
      }
      return () => h('Story')
    },
  })
}

export const PasswortAnfordern: Story = {
  name: 'Passwort-Reset anfordern',
  decorators: [withRoute('/forgot-password')],
}

export const NeuesPasswortSetzen: Story = {
  name: 'Neues Passwort setzen (mit Token)',
  decorators: [withRoute('/forgot-password?token=reset-token-abc123')],
}

export const TokenUngueltig: Story = {
  name: 'Token ungültig (Server-Fehler)',
  decorators: [withRoute('/forgot-password?token=bad-token')],
  parameters: {
    msw: {
      handlers: [
        http.post('/api/auth/reset-password', () =>
          HttpResponse.json(
            { code: 'invalid_argument', message: 'Token ist abgelaufen oder ungültig.' },
            { status: 400 },
          ),
        ),
        ...defaultHandlers,
      ],
    },
  },
}
