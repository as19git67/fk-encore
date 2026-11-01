<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import DocumentUploadDefaultsDialog from '../DocumentUploadDefaultsDialog.vue'
import { getUploadDefaults, listGroups, type GroupSummary } from '../../api/documents'
import { UPLOAD_DEFAULTS_ACTION, useModuleMenuActionsStore } from '../../stores/moduleMenuActions'

/**
 * "Standard für neue Dokumente" lives in the module's gear, so the dialog has
 * to open on every documents page. App.vue mounts this for the documents
 * module; it also tells the gear whether the saved default group still
 * holds (a group the user left sends new documents to private silently).
 */
const actions = useModuleMenuActionsStore()

const groups = ref<GroupSummary[]>([])
const visible = ref(false)

// The dialog picks its starting choice from `groups` the moment it opens, so
// the groups are fetched first (once) and only then is it shown.
watch(
  () => !!actions.open[UPLOAD_DEFAULTS_ACTION],
  async (requested) => {
    if (!requested) {
      visible.value = false
      return
    }
    if (!groups.value.length) {
      try {
        groups.value = (await listGroups()).items
      } catch (err) {
        console.warn('[documents] failed to load groups:', err)
      }
    }
    visible.value = true
  },
)

function onVisible(v: boolean) {
  visible.value = v
  if (!v) actions.setOpen(UPLOAD_DEFAULTS_ACTION, false)
}

onMounted(async () => {
  try {
    actions.setWarn(UPLOAD_DEFAULTS_ACTION, (await getUploadDefaults()).stale)
  } catch (err) {
    console.warn('[documents] failed to load upload defaults:', err)
  }
})

function onSaved() {
  actions.setWarn(UPLOAD_DEFAULTS_ACTION, false)
}
</script>

<template>
  <DocumentUploadDefaultsDialog :visible="visible" :groups="groups" @update:visible="onVisible" @saved="onSaved" />
</template>
