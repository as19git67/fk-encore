import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Menu entries that open something in place instead of going to a route
 * (`ModuleMenuItem.action`): the gear's "Standard für neue Dokumente" opens
 * a dialog wherever in the module the user is. App.vue raises the request,
 * the component that owns the dialog (mounted by App.vue for its module)
 * answers it and may flag its entry with a warning, which the gear shows as
 * a dot.
 */
/** The gear's "Standard für neue Dokumente" (documents module). */
export const UPLOAD_DEFAULTS_ACTION = 'documents.upload-defaults'

export const useModuleMenuActionsStore = defineStore('moduleMenuActions', () => {
  /** Which actions are open right now. */
  const open = ref<Record<string, boolean>>({})
  /** Actions whose entry should warn (the saved default no longer holds). */
  const warn = ref<Record<string, boolean>>({})

  function request(action: string) {
    open.value = { ...open.value, [action]: true }
  }
  function setOpen(action: string, value: boolean) {
    open.value = { ...open.value, [action]: value }
  }
  function setWarn(action: string, value: boolean) {
    warn.value = { ...warn.value, [action]: value }
  }

  return { open, warn, request, setOpen, setWarn }
})
