<script setup lang="ts">
import AdminPage from '../components/admin/AdminPage.vue'
import DocumentQueuePanel from '../components/admin/DocumentQueuePanel.vue'
import SourceFolderBackfillPanel from '../components/admin/SourceFolderBackfillPanel.vue'
</script>

<template>
  <AdminPage title="Dokument-Verarbeitung">
    <DocumentQueuePanel />
    <SourceFolderBackfillPanel />
  </AdminPage>
</template>
