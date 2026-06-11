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
import { deviceSupportsHoverTooltips } from './utils/tooltips'

function getFirstDayOfWeek(): number {
  try {
    const locale = new Intl.Locale(navigator.language)
    if ('weekInfo' in locale) {
      // Intl.Locale.weekInfo.firstDay: 1=Mon … 6=Sat, 7=Sun
      // PrimeVue firstDayOfWeek:       0=Sun, 1=Mon … 6=Sat
      const firstDay = (locale as unknown as { weekInfo: { firstDay: number } }).weekInfo.firstDay
      return firstDay === 7 ? 0 : firstDay
    }
  } catch {}
  // Fallback for browsers without weekInfo
  const lang = navigator.language.split('-')[0].toLowerCase()
  const mondayLocales = ['de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'no', 'fi', 'ru', 'cs', 'hu', 'ro', 'tr']
  return mondayLocales.includes(lang) ? 1 : 0
}

function buildPrimeVueLocale() {
  const firstDayOfWeek = getFirstDayOfWeek()
  const lang = navigator.language.split('-')[0].toLowerCase()
  if (lang === 'de') {
    return {
      firstDayOfWeek,
      dayNames: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
      dayNamesShort: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
      dayNamesMin: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
      monthNames: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
      monthNamesShort: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
      today: 'Heute',
      clear: 'Löschen',
      weekHeader: 'KW',
    }
  }
  return { firstDayOfWeek }
}

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
  locale: buildPrimeVueLocale(),
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
// On touch / hover-less devices (iOS Safari especially) a hover tooltip makes
// the first tap a no-op — it only shows the tooltip; the click needs a second
// or third tap. Register the tooltip directive as a no-op there so the first
// tap always clicks. Desktop / trackpad devices keep real tooltips.
app.directive('tooltip', deviceSupportsHoverTooltips() ? Tooltip : {})

app.mount('#app')
