import type { Preview } from '@storybook/vue3'
import { setup } from '@storybook/vue3'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'
import { definePreset } from '@primeuix/themes'
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
    { path: '/fotos/einstellungen/scan-queue', name: 'fotos-settings-scan-queue', component: { template: '<div />' } },
    { path: '/fotos/einstellungen/wartung', name: 'fotos-settings-maintenance', component: { template: '<div />' } },
    { path: '/fotos/einstellungen/bibliotheken', name: 'fotos-settings-libraries', component: { template: '<div />' } },
    { path: '/fotos/einstellungen/osm', name: 'fotos-settings-osm', component: { template: '<div />' } },
    { path: '/fotos/einstellungen/gefahrenzone', name: 'fotos-settings-purge', component: { template: '<div />' } },
    { path: '/fotos/alben', component: { template: '<div />' } },
    { path: '/fotos/alben/:id', component: { template: '<div />' } },
    { path: '/albums/shared/:token', component: { template: '<div />' } },
    { path: '/fotos/personen', component: { template: '<div />' } },
    { path: '/fotos/rueckblicke', name: 'fotos-recaps', component: { template: '<div />' } },
    // Dokumente module
    { path: '/dokumente', name: 'dokumente-list', component: { template: '<div />' } },
    { path: '/dokumente/upload', name: 'dokumente-upload', component: { template: '<div />' } },
    { path: '/dokumente/verarbeitung', name: 'dokumente-verarbeitung', component: { template: '<div />' } },
    { path: '/dokumente/korrespondenten', name: 'dokumente-korrespondenten', component: { template: '<div />' } },
    { path: '/dokumente/:id', name: 'dokumente-detail', component: { template: '<div />' } },
    // Finanzen module
    { path: '/finanzen', name: 'finance-overview', component: { template: '<div />' } },
    { path: '/finanzen/uebersicht/konto/:id', name: 'finance-account-transactions', component: { template: '<div />' } },
    { path: '/finanzen/uebersicht/sektion/:name', name: 'finance-section-transactions', component: { template: '<div />' } },
    { path: '/finanzen/konten', name: 'finance-accounts', component: { template: '<div />' } },
    { path: '/finanzen/umsaetze/:id', name: 'finance-transaction-detail', component: { template: '<div />' } },
    { path: '/finanzen/bankkontakte', name: 'finance-bankcontacts', component: { template: '<div />' } },
    { path: '/finanzen/bankkontakte/:id', name: 'finance-bankcontact-detail', component: { template: '<div />' } },
    { path: '/finanzen/ki-tagging', name: 'finance-tag-queue', component: { template: '<div />' } },
    // Admin module
    { path: '/admin', component: { template: '<div />' } },
    { path: '/admin/benutzer/:id', component: { template: '<div />' } },
    { path: '/admin/rollen', component: { template: '<div />' } },
    { path: '/admin/status', name: 'admin-status', component: { template: '<div />' } },
    { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
  ],
})

// Called once per story's Vue app instance
setup((app) => {
  const pinia = createPinia()
  app.use(pinia)
  app.use(router)
  const F4milPreset = definePreset(Aura, {
    semantic: {
      primary: {
        50: '{amber.50}',
        100: '{amber.100}',
        200: '{amber.200}',
        300: '{amber.300}',
        400: '{amber.400}',
        500: '{amber.500}',
        600: '{amber.600}',
        700: '{amber.700}',
        800: '{amber.800}',
        900: '{amber.900}',
        950: '{amber.950}',
      },
    },
  })
  app.use(PrimeVue, { theme: { preset: F4milPreset } })
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
