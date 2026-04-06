import type { Preview } from '@storybook/vue3'
import { setup } from '@storybook/vue3'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'
import ConfirmationService from 'primevue/confirmationservice'
import Tooltip from 'primevue/tooltip'
import { createRouter, createMemoryHistory } from 'vue-router'
import { initialize, mswLoader } from 'msw-storybook-addon'
import 'primeicons/primeicons.css'
import '../src/style.css'
import { useAuthStore } from '../src/stores/auth'
import { MOCK_USER } from '../src/stories/mock-data'

// Initialize MSW – unhandled requests pass through to Vite dev server
initialize({ onUnhandledRequest: 'bypass' })

// Stub router: same routes as the real app but without auth guards
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
    { path: '/register', component: { template: '<div />' } },
    { path: '/profile', component: { template: '<div />' } },
    // Fotos module
    { path: '/fotos', component: { template: '<div />' } },
    { path: '/fotos/alben', component: { template: '<div />' } },
    { path: '/fotos/alben/:id', component: { template: '<div />' } },
    { path: '/albums/shared/:token', component: { template: '<div />' } },
    { path: '/fotos/personen', component: { template: '<div />' } },
    // Admin module
    { path: '/admin', component: { template: '<div />' } },
    { path: '/admin/benutzer/:id', component: { template: '<div />' } },
    { path: '/admin/rollen', component: { template: '<div />' } },
    { path: '/admin/daten', component: { template: '<div />' } },
    { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
  ],
})

// Called once per story's Vue app instance
setup((app) => {
  const pinia = createPinia()
  app.use(pinia)
  app.use(router)
  app.use(PrimeVue, { theme: { preset: Aura } })
  app.use(ConfirmationService)
  app.directive('tooltip', Tooltip)

  // Pre-populate auth store with a mock admin user
  const authStore = useAuthStore(pinia)
  authStore.user = MOCK_USER
  authStore.token = 'mock-token-storybook'
})

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    layout: 'fullscreen',
  },
  loaders: [mswLoader],
}

export default preview
