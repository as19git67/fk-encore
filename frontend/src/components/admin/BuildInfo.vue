<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getBuildInfo } from '../../api/system'

const buildNumber = ref('…')

onMounted(() => {
  getBuildInfo().then(info => { buildNumber.value = info.build })
})
</script>

<template>
  <div class="data-management-group">
    <h3>Version</h3>
    <span class="build-number">Build {{ buildNumber }}</span>
  </div>
</template>

<style scoped src="./adminPanels.css"></style>
<style scoped>
.build-number {
  font-size: 0.85rem;
  color: var(--p-text-muted-color, #888);
  font-family: monospace;
}
</style>
