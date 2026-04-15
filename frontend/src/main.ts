import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import Aura from '@primeuix/themes/aura'
import { definePreset } from '@primeuix/themes'
import 'primeicons/primeicons.css'
import App from './App.vue'
import router from './router'
import './style.css'
import Tooltip from 'primevue/tooltip'

const app = createApp(App)

app.use(createPinia())
app.use(router)
const VivantyPreset = definePreset(Aura, {
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

app.use(PrimeVue, {
  theme: {
    preset: VivantyPreset,
    options: {
      darkModeSelector: 'system',
    },
  },
  zIndex: {
    // Must sit above --z-fullscreen (1200) so popups, dialogs and tooltips
    // triggered from buttons inside FullscreenOverlay are not hidden behind
    // the overlay.
    modal: 1250,
    overlay: 1250,
    menu: 1250,
    tooltip: 1300,
  },
})
app.use(ConfirmationService)
app.directive('tooltip', Tooltip)

app.mount('#app')
