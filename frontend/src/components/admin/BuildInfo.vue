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
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
  font-family: monospace;
}
</style>
