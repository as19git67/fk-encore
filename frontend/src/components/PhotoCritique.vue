<script setup lang="ts">
/**
 * The critique of one photo in words (documentation/plans/foto-aesthetik.md,
 * stage 6). Shows the kept one at once; a new one only on the button, because
 * each costs the GPU a look at the picture.
 */
import { ref, watch } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { getPhotoCritique, requestPhotoCritique, type PhotoCritique } from '../api/photoCritique'

const props = defineProps<{ photoId: number }>()

const critique = ref<PhotoCritique | null>(null)
const loaded = ref(false)
const asking = ref(false)
const error = ref<string | null>(null)

let seq = 0

watch(
  () => props.photoId,
  async (id) => {
    const mine = ++seq
    critique.value = null
    loaded.value = false
    error.value = null
    asking.value = false
    try {
      const res = await getPhotoCritique(id)
      if (mine === seq) critique.value = res.critique
    } catch {
      // Not loading a kept critique is no reason to hide the button.
    } finally {
      if (mine === seq) loaded.value = true
    }
  },
  { immediate: true },
)

async function ask(refresh: boolean) {
  const mine = seq
  asking.value = true
  error.value = null
  try {
    const res = await requestPhotoCritique(props.photoId, refresh)
    if (mine === seq) critique.value = res.critique
  } catch (err) {
    if (mine === seq) error.value = err instanceof Error ? err.message : 'Die KI konnte das Bild nicht besprechen.'
  } finally {
    if (mine === seq) asking.value = false
  }
}
</script>

<template>
  <div class="critique" :aria-busy="asking">
    <template v-if="critique">
      <p v-if="critique.summary" class="critique-summary">{{ critique.summary }}</p>
      <div v-if="critique.strengths.length" class="critique-block">
        <div class="critique-heading"><i class="pi pi-thumbs-up" /> Gelingt</div>
        <ul>
          <li v-for="s in critique.strengths" :key="s">{{ s }}</li>
        </ul>
      </div>
      <div v-if="critique.weaknesses.length" class="critique-block">
        <div class="critique-heading"><i class="pi pi-wrench" /> Ginge besser</div>
        <ul>
          <li v-for="w in critique.weaknesses" :key="w">{{ w }}</li>
        </ul>
      </div>
      <div class="critique-foot">
        <span class="critique-hint">Von der KI beschrieben, nicht bewertet.</span>
        <Button
          icon="pi pi-refresh"
          text
          rounded
          size="small"
          aria-label="Neu erklären lassen"
          v-tooltip.top="'Neu erklären lassen'"
          :loading="asking"
          @click="ask(true)"
        />
      </div>
    </template>
    <Button
      v-else-if="loaded"
      icon="pi pi-sparkles"
      label="Bild erklären lassen"
      outlined
      size="small"
      :loading="asking"
      @click="ask(false)"
    />
    <p v-if="asking && !critique" class="critique-hint">Die KI sieht sich das Bild an…</p>
    <Message v-if="error" severity="warn" size="small" :closable="false" class="critique-error">{{ error }}</Message>
  </div>
</template>

<style scoped>
.critique {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.critique-summary {
  margin: 0;
  color: var(--p-text-color);
  font-size: var(--text-sm);
  line-height: 1.45;
}
.critique-block ul {
  margin: var(--space-1) 0 0;
  padding-left: 1.2em;
  color: var(--p-text-color);
  font-size: var(--text-sm);
}
.critique-heading {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--p-text-muted-color);
  font-size: var(--text-xs);
  font-weight: 600;
}
.critique-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.critique-hint {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-xs);
}
.critique-error {
  margin: 0;
}
</style>
