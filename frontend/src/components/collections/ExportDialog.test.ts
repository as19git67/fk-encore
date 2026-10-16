import { describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, h } from 'vue'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import ExportDialog from './ExportDialog.vue'

describe('ExportDialog', () => {
  // Every basket drawer carries the dialog closed in its footer; mounting it
  // closed once threw before the polling timer was declared.
  it('mounts closed without throwing', () => {
    const errors: unknown[] = []
    const app = createApp({
      render: () => h(ExportDialog, { visible: false, collectionId: 1, name: 'Basket', basket: true }),
    })
    app.config.errorHandler = (err) => {
      errors.push(err)
    }
    app.use(createPinia()).use(PrimeVue).use(ConfirmationService).mount(document.createElement('div'))
    expect(errors).toEqual([])
    app.unmount()
  })
})
