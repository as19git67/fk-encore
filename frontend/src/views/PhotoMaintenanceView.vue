<script setup lang="ts">
import { computed } from 'vue'
import AdminPage from '../components/admin/AdminPage.vue'
import PhotoGroupingPanel from '../components/admin/PhotoGroupingPanel.vue'
import GpsRescanPanel from '../components/admin/GpsRescanPanel.vue'
import AutoCropPanel from '../components/admin/AutoCropPanel.vue'
import TransformSuggestionsPanel from '../components/admin/TransformSuggestionsPanel.vue'
import MetadataRefreshPanel from '../components/admin/MetadataRefreshPanel.vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
// The metadata endpoints require their own permission, not data.manage —
// showing the button to someone who only holds data.manage earns a 403.
const canRefreshMetadata = computed(() => auth.hasPermission('photos.refresh_metadata'))
</script>

<template>
  <AdminPage title="Foto-Wartung">
    <PhotoGroupingPanel />
    <GpsRescanPanel />
    <AutoCropPanel />
    <TransformSuggestionsPanel />
    <MetadataRefreshPanel v-if="canRefreshMetadata" />
  </AdminPage>
</template>
