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
      50: '{fuchsia.50}',
      100: '{fuchsia.100}',
      200: '{fuchsia.200}',
      300: '{fuchsia.300}',
      400: '{fuchsia.400}',
      500: '{fuchsia.500}',
      600: '{fuchsia.600}',
      700: '{fuchsia.700}',
      800: '{fuchsia.800}',
      900: '{fuchsia.900}',
      950: '{fuchsia.950}',
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
})
app.use(ConfirmationService)
app.directive('tooltip', Tooltip)

app.mount('#app')
