<script setup lang="ts">
import AdminPage from '../components/admin/AdminPage.vue'
import DocumentQueuePanel from '../components/admin/DocumentQueuePanel.vue'
import SourceFolderBackfillPanel from '../components/admin/SourceFolderBackfillPanel.vue'
import InboxFoldersPanel from '../components/admin/InboxFoldersPanel.vue'
</script>

<template>
  <AdminPage title="Dokument-Verarbeitung">
    <DocumentQueuePanel />
    <InboxFoldersPanel />
    <SourceFolderBackfillPanel />
  </AdminPage>
</template>
